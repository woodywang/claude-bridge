import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  initCrypto,
  generateKeypair,
  computeSharedSecret,
  decrypt,
} from '../shared/crypto.js';
import {
  deserializeMessage,
  type BridgeMessage,
} from '../shared/protocol.js';
import { BridgeWebSocket } from './websocket.js';
import { registerTools, type BridgeState } from './tools.js';

async function main(): Promise<void> {
  // -----------------------------------------------------------------------
  // 1. Read config from environment
  // -----------------------------------------------------------------------
  const role = process.env.BRIDGE_ROLE as 'host' | 'peer' | undefined;
  if (role !== 'host' && role !== 'peer') {
    console.error('[bridge] BRIDGE_ROLE must be "host" or "peer"');
    process.exit(1);
  }

  let roomCode = process.env.BRIDGE_CODE ?? '';
  const workerUrl = process.env.BRIDGE_WORKER_URL;
  if (!workerUrl) {
    console.error('[bridge] BRIDGE_WORKER_URL is required');
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // 2. Initialize crypto
  // -----------------------------------------------------------------------
  console.error('[bridge] Initializing crypto...');
  await initCrypto();

  // -----------------------------------------------------------------------
  // 3. If host and no code, create room via HTTP POST
  // -----------------------------------------------------------------------
  if (role === 'host' && !roomCode) {
    console.error('[bridge] Creating room...');
    const createUrl = `${workerUrl}/room`;
    const resp = await fetch(createUrl, { method: 'POST' });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[bridge] Failed to create room: ${resp.status} ${text}`);
      process.exit(1);
    }
    const body = (await resp.json()) as { code: string };
    roomCode = body.code;
    console.error(`[bridge] Room created with code: ${roomCode}`);
  }

  if (!roomCode) {
    console.error('[bridge] BRIDGE_CODE is required for peer role');
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // 4. Generate keypair
  // -----------------------------------------------------------------------
  const keypair = generateKeypair();
  console.error('[bridge] Keypair generated');

  // -----------------------------------------------------------------------
  // 5. Build shared state
  // -----------------------------------------------------------------------
  const state: BridgeState = {
    role,
    roomCode,
    ws: null!, // set below after creating WebSocket
    keypair,
    sharedSecret: null,
    inbox: [],
  };

  // -----------------------------------------------------------------------
  // 6. Create WebSocket and wire up message handler
  // -----------------------------------------------------------------------
  const wsProto = workerUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = workerUrl.replace(/^https?:\/\//, '');
  const wsUrl = `${wsProto}://${wsHost}/room/${roomCode}/ws`;

  const ws = new BridgeWebSocket(
    wsUrl,
    (rawData: string) => {
      handleRelayMessage(rawData, state);
    },
    () => {
      sendKeyExchange(state);
    },
  );
  state.ws = ws;

  // Connect to WebSocket
  console.error(`[bridge] Connecting to ${wsUrl}...`);
  try {
    await ws.connect();
  } catch (err) {
    console.error(
      `[bridge] Initial WebSocket connection failed: ${(err as Error).message}`,
    );
    console.error('[bridge] Will retry via auto-reconnect...');
    // Don't exit — the auto-reconnect in BridgeWebSocket will keep trying.
    // We still start the MCP server so Claude Code can query status.
  }

  // -----------------------------------------------------------------------
  // 8. Create MCP Server, register tools, start stdio transport
  // -----------------------------------------------------------------------
  const mcpServer = new McpServer(
    {
      name: 'claude-bridge',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerTools(mcpServer, state);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('[bridge] MCP server started (stdio transport)');
  console.error(
    `[bridge] Role=${role}, Room=${roomCode}, WS=${ws.connected ? 'connected' : 'disconnected'}`,
  );
}

// ---------------------------------------------------------------------------
// Relay message handler
// ---------------------------------------------------------------------------

function handleRelayMessage(rawData: string, state: BridgeState): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(rawData);
  } catch {
    console.error('[bridge] Failed to parse relay message as JSON');
    return;
  }

  const payload = msg.payload as Record<string, unknown> | undefined;
  if (!payload) {
    // Could be a system message from the DO (e.g., room_status)
    console.error(`[bridge] Non-payload message: ${JSON.stringify(msg)}`);
    return;
  }

  // Key exchange (control plane)
  if (payload.controlType === 'key_exchange') {
    handleKeyExchange(payload, state);
    return;
  }

  // Encrypted data (data plane)
  if (payload.dataType === 'encrypted') {
    handleEncryptedMessage(payload, state);
    return;
  }

  console.error(`[bridge] Unknown payload type: ${JSON.stringify(payload)}`);
}

function handleKeyExchange(
  payload: Record<string, unknown>,
  state: BridgeState,
): void {
  if (state.sharedSecret) {
    console.error('[bridge] Key exchange already done, ignoring duplicate');
    return;
  }

  const peerPubKeyB64 = payload.publicKey as string | undefined;
  if (!peerPubKeyB64) {
    console.error('[bridge] Key exchange message missing publicKey');
    return;
  }

  try {
    const peerPublicKey = new Uint8Array(
      Buffer.from(peerPubKeyB64, 'base64'),
    );

    state.sharedSecret = computeSharedSecret(
      peerPublicKey,
      state.keypair.privateKey,
    );
    console.error('[bridge] Shared secret computed — key exchange done!');

    // Re-send our public key so the peer can also complete key exchange
    // (handles timing: if peer connected first and sent their key before we did)
    sendKeyExchange(state);
  } catch (err) {
    console.error(
      `[bridge] Key exchange failed: ${(err as Error).message}`,
    );
  }
}

function handleEncryptedMessage(
  payload: Record<string, unknown>,
  state: BridgeState,
): void {
  if (!state.sharedSecret) {
    console.error(
      '[bridge] Received encrypted message but no shared secret yet — dropping',
    );
    return;
  }

  const blob = payload.blob as string | undefined;
  if (!blob) {
    console.error('[bridge] Encrypted message missing blob');
    return;
  }

  try {
    const encrypted = new Uint8Array(Buffer.from(blob, 'base64'));
    const decrypted = decrypt(encrypted, state.sharedSecret);
    const message: BridgeMessage = deserializeMessage(decrypted);
    state.inbox.push(message);
    console.error(
      `[bridge] Received message: type=${message.type}, id=${message.id} (inbox size: ${state.inbox.length})`,
    );
  } catch (err) {
    console.error(
      `[bridge] Failed to decrypt/deserialize message: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Key exchange helper
// ---------------------------------------------------------------------------

function sendKeyExchange(state: BridgeState): void {
  if (!state.ws.connected) {
    console.error('[bridge] Cannot send key exchange — WebSocket not connected');
    return;
  }

  const pubKeyB64 = Buffer.from(state.keypair.publicKey).toString('base64');
  const envelope = JSON.stringify({
    type: 'relay',
    payload: {
      controlType: 'key_exchange',
      publicKey: pubKeyB64,
    },
  });
  state.ws.send(envelope);
  console.error('[bridge] Sent key exchange (public key)');
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(`[bridge] Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
