import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  initCrypto,
  generateKeypair,
  computeSharedSecret,
  decrypt,
  fingerprint,
} from '../shared/crypto.js';
import {
  deserializeMessage,
  type BridgeMessage,
  type ChatPayload,
  type TaskPayload,
  type ResultPayload,
  type ContextPayload,
} from '../shared/protocol.js';
import { BridgeWebSocket } from './websocket.js';
import { registerTools, type BridgeState, type InboxMessage, type LocalTask } from './tools.js';
import { writeToInbox, ensureInboxDir, initCounts, writeCounts, type InboxEntry } from './inbox.js';

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
  // Init counts file FIRST — status line reads this on Claude Code startup
  const projectDir = process.env.BRIDGE_PROJECT_DIR ?? process.cwd();
  initCounts(projectDir);

  console.error('[bridge] Initializing crypto...');
  await initCrypto();
  ensureInboxDir();

  // -----------------------------------------------------------------------
  // 3. If host and no code, create room via HTTP POST
  // -----------------------------------------------------------------------
  if (role === 'host' && !roomCode) {
    console.error('[bridge] Creating room...');
    const createUrl = `${workerUrl}/room/create`;
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
  const myFingerprint = fingerprint(keypair.publicKey);
  console.error(`[bridge] Keypair generated (fingerprint: ${myFingerprint})`);

  // -----------------------------------------------------------------------
  // 5. Build shared state
  // -----------------------------------------------------------------------
  const state: BridgeState = {
    role,
    roomCode,
    ws: null!, // set below after creating WebSocket
    keypair,
    myFingerprint,
    peers: new Map(),
    inbox: new Map(),
    tasks: new Map(),
    context: new Map(),
    syncCounts: () => {}, // replaced below after full init
  };
  state.syncCounts = () => syncCounts(state);

  // -----------------------------------------------------------------------
  // 6. Create WebSocket and wire up message handler
  // -----------------------------------------------------------------------
  const wsProto = workerUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = workerUrl.replace(/^https?:\/\//, '');
  const wsUrl = `${wsProto}://${wsHost}/room/${roomCode}/ws`;

  const ws = new BridgeWebSocket(
    wsUrl,
    (data: unknown) => {
      handleRelayMessage(data, state);
    },
    () => {
      sendRegister(state);
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

  // Periodically refresh counts.json to keep it fresh (status line ignores files >30s old)
  setInterval(() => syncCounts(state), 10_000);
}

// ---------------------------------------------------------------------------
// Counts sync
// ---------------------------------------------------------------------------

function syncCounts(state: BridgeState): void {
  const pendingTasks = [...state.tasks.values()].filter(
    (t) => t.direction === 'received' && (t.status === 'pending' || t.status === 'ack' || t.status === 'in_progress'),
  ).length;
  const unreadChat = [...state.inbox.values()].filter((m) => !m.read).length;
  writeCounts({ unreadChat, pendingTasks, total: unreadChat + pendingTasks });
}

// ---------------------------------------------------------------------------
// Relay message handler
// ---------------------------------------------------------------------------

function handleRelayMessage(data: unknown, state: BridgeState): void {
  if (!data || typeof data !== 'object') {
    console.error('[bridge] Received non-object relay message');
    return;
  }
  const msg = data as Record<string, unknown>;

  // DO control messages (no payload wrapper)
  if (msg.type === 'members') {
    handleMembers(msg, state);
    return;
  }
  if (msg.type === 'member_joined') {
    handleMemberJoined(msg, state);
    return;
  }
  if (msg.type === 'member_left') {
    console.error(`[bridge] Peer left: ${msg.fingerprint}`);
    // Don't remove from peers — they might reconnect, and we still need their key for offline messages
    return;
  }

  // Relay messages (with payload wrapper)
  const payload = msg.payload as Record<string, unknown> | undefined;
  if (!payload) {
    console.error(`[bridge] Non-payload message: ${JSON.stringify(msg)}`);
    return;
  }

  // Encrypted data (data plane)
  if (payload.dataType === 'encrypted') {
    handleEncryptedMessage(payload, state);
    return;
  }

  console.error(`[bridge] Unknown payload type: ${JSON.stringify(payload)}`);
}

function handleMembers(data: Record<string, unknown>, state: BridgeState): void {
  const members = data.members as Array<{ fingerprint: string; publicKey: string; name?: string; online: boolean }>;
  if (!Array.isArray(members)) return;

  for (const member of members) {
    if (member.fingerprint === state.myFingerprint) continue; // skip self
    if (state.peers.has(member.fingerprint)) continue; // already known

    try {
      const peerPublicKey = new Uint8Array(Buffer.from(member.publicKey, 'base64'));
      const sharedSecret = computeSharedSecret(peerPublicKey, state.keypair.privateKey);
      state.peers.set(member.fingerprint, {
        fingerprint: member.fingerprint,
        publicKey: peerPublicKey,
        sharedSecret,
      });
      console.error(`[bridge] Added peer ${member.fingerprint} (${member.name ?? 'unknown'}, ${member.online ? 'online' : 'offline'})`);
    } catch (err) {
      console.error(`[bridge] Failed to add peer ${member.fingerprint}: ${(err as Error).message}`);
    }
  }
  console.error(`[bridge] ${state.peers.size} peers after member sync`);
}

function handleMemberJoined(data: Record<string, unknown>, state: BridgeState): void {
  const member = data.member as { fingerprint: string; publicKey: string; name?: string } | undefined;
  if (!member || member.fingerprint === state.myFingerprint) return;
  if (state.peers.has(member.fingerprint)) return;

  try {
    const peerPublicKey = new Uint8Array(Buffer.from(member.publicKey, 'base64'));
    const sharedSecret = computeSharedSecret(peerPublicKey, state.keypair.privateKey);
    state.peers.set(member.fingerprint, {
      fingerprint: member.fingerprint,
      publicKey: peerPublicKey,
      sharedSecret,
    });
    console.error(`[bridge] New peer joined: ${member.fingerprint} (${member.name ?? 'unknown'})`);
  } catch (err) {
    console.error(`[bridge] Failed to add new peer: ${(err as Error).message}`);
  }
}

function handleEncryptedMessage(
  payload: Record<string, unknown>,
  state: BridgeState,
): void {
  const fromFp = payload.from as string | undefined;
  const recipients = payload.recipients as Record<string, string> | undefined;

  // Support both new multi-party format and legacy single-blob format
  let blob: string | undefined;
  let senderFp: string | undefined;

  if (recipients && fromFp) {
    // New format: find our copy
    blob = recipients[state.myFingerprint];
    senderFp = fromFp;
    if (!blob) {
      // Message not addressed to us
      return;
    }
  } else {
    // Legacy format (single blob) - try all peers
    blob = payload.blob as string | undefined;
    senderFp = fromFp;
  }

  if (!blob) {
    console.error('[bridge] Encrypted message missing blob');
    return;
  }

  // Find the peer's shared secret for decryption
  let sharedSecret: Uint8Array | undefined;
  if (senderFp && state.peers.has(senderFp)) {
    sharedSecret = state.peers.get(senderFp)!.sharedSecret;
  } else {
    // Try each peer's secret (fallback for legacy messages without from field)
    for (const peer of state.peers.values()) {
      try {
        const encrypted = new Uint8Array(Buffer.from(blob, 'base64'));
        const decrypted = decrypt(encrypted, peer.sharedSecret);
        // If we get here without throwing, this is the right key
        const message: BridgeMessage = deserializeMessage(decrypted);
        handleDecryptedMessage(message, state);
        return;
      } catch {
        continue;
      }
    }
    console.error('[bridge] Could not decrypt message with any known peer key');
    return;
  }

  try {
    const encrypted = new Uint8Array(Buffer.from(blob, 'base64'));
    const decrypted = decrypt(encrypted, sharedSecret);
    const message: BridgeMessage = deserializeMessage(decrypted);
    handleDecryptedMessage(message, state);
  } catch (err) {
    console.error(`[bridge] Failed to decrypt/deserialize: ${(err as Error).message}`);
  }
}

function handleDecryptedMessage(message: BridgeMessage, state: BridgeState): void {
  switch (message.type) {
    case 'task': {
      const taskPayload = message.payload as TaskPayload;
      const now = Date.now();
      const localTask: LocalTask = {
        id: message.id,
        description: taskPayload.description,
        context: taskPayload.context,
        priority: taskPayload.priority,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        direction: 'received',
      };
      state.tasks.set(message.id, localTask);

      // Write to inbox file for hook pickup
      const inboxEntry: InboxEntry = {
        id: message.id,
        type: 'task',
        from: message.from,
        timestamp: message.timestamp,
        summary: `[${taskPayload.priority}] ${taskPayload.description}`,
      };
      writeToInbox(inboxEntry);

      console.error(
        `[bridge] Received task: id=${message.id}, priority=${taskPayload.priority}`,
      );
      break;
    }

    case 'result': {
      const resultPayload = message.payload as ResultPayload;
      const task = state.tasks.get(resultPayload.taskId);
      if (task) {
        task.status = resultPayload.status;
        if (resultPayload.summary) {
          task.result = resultPayload.summary;
        }
        task.updatedAt = Date.now();
        console.error(
          `[bridge] Task ${resultPayload.taskId} updated to status=${resultPayload.status}`,
        );
      } else {
        console.error(
          `[bridge] Received result for unknown task: ${resultPayload.taskId}`,
        );
      }

      // Also write to inbox for hook notification
      const resultInboxEntry: InboxEntry = {
        id: message.id,
        type: 'result',
        from: message.from,
        timestamp: message.timestamp,
        summary: `Task ${resultPayload.taskId} -> ${resultPayload.status}${resultPayload.summary ? ': ' + resultPayload.summary : ''}`,
      };
      writeToInbox(resultInboxEntry);
      break;
    }

    case 'context': {
      const ctxPayload = message.payload as ContextPayload;
      const existingEntry = state.context.get(ctxPayload.key);

      // Last-write-wins by timestamp
      if (
        !existingEntry ||
        message.timestamp >= existingEntry.timestamp
      ) {
        switch (ctxPayload.operation) {
          case 'set':
            state.context.set(ctxPayload.key, {
              value: ctxPayload.value,
              timestamp: message.timestamp,
            });
            break;
          case 'append': {
            const prev = existingEntry?.value ?? '';
            state.context.set(ctxPayload.key, {
              value: prev + ctxPayload.value,
              timestamp: message.timestamp,
            });
            break;
          }
          case 'delete':
            state.context.delete(ctxPayload.key);
            break;
        }
      }

      console.error(
        `[bridge] Context ${ctxPayload.operation}: key=${ctxPayload.key}`,
      );
      break;
    }

    case 'chat':
    default: {
      const chatPayload = message.payload as ChatPayload;

      // Create InboxMessage and store in map
      const inboxMsg: InboxMessage = {
        id: message.id,
        title: chatPayload.title,
        body: chatPayload.body,
        from: message.from,
        timestamp: message.timestamp,
        read: false,
        replyTo: chatPayload.replyTo,
      };
      state.inbox.set(message.id, inboxMsg);

      // Write to inbox file for hook pickup
      const chatInboxEntry: InboxEntry = {
        id: message.id,
        type: message.type,
        from: message.from,
        timestamp: message.timestamp,
        summary:
          message.type === 'chat'
            ? chatPayload.title
            : JSON.stringify(message.payload),
      };
      writeToInbox(chatInboxEntry);
      break;
    }
  }

  syncCounts(state);
  console.error(
    `[bridge] Received message: type=${message.type}, id=${message.id}`,
  );
}

// ---------------------------------------------------------------------------
// Register helper
// ---------------------------------------------------------------------------

function sendRegister(state: BridgeState): void {
  if (!state.ws.connected) {
    console.error('[bridge] Cannot register — WebSocket not connected');
    return;
  }

  const pubKeyB64 = Buffer.from(state.keypair.publicKey).toString('base64');
  state.ws.send(JSON.stringify({
    type: 'register',
    fingerprint: state.myFingerprint,
    publicKey: pubKeyB64,
    name: state.role, // use role as display name for now
  }));
  console.error(`[bridge] Registered with room (fingerprint: ${state.myFingerprint})`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(`[bridge] Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
