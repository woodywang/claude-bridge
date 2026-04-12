/**
 * claude-bridge MCP Server Spike
 *
 * Validates: MCP StdioServerTransport + WebSocket long-lived connection in the same process.
 *
 * Usage:
 *   BRIDGE_ROLE=host node mcp-spike.mjs            # creates room, prints code to stderr
 *   BRIDGE_ROLE=join BRIDGE_CODE=XXX node mcp-spike.mjs  # joins existing room
 *
 * Tools exposed to Claude Code:
 *   bridge_status          - show connection state
 *   bridge_send_message    - send encrypted message to peer
 *   bridge_get_messages    - drain pending incoming messages
 */

import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket } from 'ws';

// libsodium must be loaded via CJS — ESM build has broken companion file on Node 25
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');
await sodium.ready;

// ─── Config ───────────────────────────────────────────────────────────────────

const WORKER_URL = process.env.BRIDGE_WORKER_URL ?? 'http://localhost:8787';
const WS_BASE    = WORKER_URL.replace(/^http/, 'ws');
const ROLE       = process.env.BRIDGE_ROLE ?? 'host';
const CODE_IN    = process.env.BRIDGE_CODE ?? null;

if (ROLE === 'join' && !CODE_IN) {
  console.error('[bridge] ERROR: BRIDGE_ROLE=join requires BRIDGE_CODE env var');
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────

let ws        = null;
let roomCode  = null;
const kp      = sodium.crypto_box_keypair();   // our X25519 keypair
let peerKey   = null;                          // peer's public key (Uint8Array)
let shared    = null;                          // computed shared secret
const inbox   = [];                            // decrypted incoming messages
const keyWaiters = [];                         // resolve callbacks waiting for key exchange

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function encrypt(obj) {
  const nonce   = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const plain   = Buffer.from(JSON.stringify(obj));
  if (plain.length > 256 * 1024) throw new Error('Message exceeds 256 KB limit');
  const cipher  = sodium.crypto_box_easy_afternm(plain, nonce, shared);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]).toString('base64');
}

function decrypt(b64) {
  const wire   = Buffer.from(b64, 'base64');
  const nonce  = wire.subarray(0, sodium.crypto_box_NONCEBYTES);
  const cipher = wire.subarray(sodium.crypto_box_NONCEBYTES);
  const plain  = sodium.crypto_box_open_easy_afternm(cipher, nonce, shared);
  return JSON.parse(Buffer.from(plain).toString());
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function handleWsMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  const p = msg.payload;
  if (!p) return;

  // Control plane: key exchange
  if (p.controlType === 'key_exchange' && !shared) {
    peerKey = Buffer.from(p.publicKey, 'base64');
    shared  = sodium.crypto_box_beforenm(peerKey, kp.privateKey);
    // Re-send our pubkey so peer can complete exchange even if they missed our first broadcast
    ws.send(JSON.stringify({
      type: 'relay',
      payload: { controlType: 'key_exchange', publicKey: Buffer.from(kp.publicKey).toString('base64') },
    }));
    console.error('[bridge] ✓ Key exchange complete');
    keyWaiters.splice(0).forEach(cb => cb());
    return;
  }

  // Data plane: encrypted blob
  if (p.dataType === 'encrypted' && shared) {
    try {
      const obj = decrypt(p.blob);
      inbox.push(obj);
      console.error(`[bridge] ✓ Received: type=${obj.type} from=${obj.from}`);
    } catch (e) {
      console.error('[bridge] Decrypt error:', e.message);
    }
  }
}

async function connect(code) {
  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/room/${code}/ws`;
    ws = new WebSocket(url);

    ws.once('open', () => {
      console.error(`[bridge] Connected to room ${code} as ${ROLE}`);
      // Immediately publish our public key (control plane, unencrypted)
      ws.send(JSON.stringify({
        type: 'relay',
        payload: {
          controlType: 'key_exchange',
          publicKey: Buffer.from(kp.publicKey).toString('base64'),
        },
      }));
      resolve();
    });

    ws.on('message', handleWsMessage);
    ws.on('error', (e) => console.error('[bridge] WS error:', e.message));
    ws.on('close', () => console.error('[bridge] WS closed'));
    ws.once('error', reject);
  });
}

function waitForKeyExchange(ms = 60_000) {
  if (shared) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Key exchange timed out')), ms);
    keyWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}

// ─── Initialise bridge ────────────────────────────────────────────────────────

if (CODE_IN) {
  // Use a pre-existing room (works for both host and join)
  roomCode = CODE_IN;
  console.error(`[bridge] Using existing room: ${roomCode} (role: ${ROLE})`);
} else if (ROLE === 'host') {
  const res  = await fetch(`${WORKER_URL}/room/create`);
  const json = await res.json();
  roomCode   = json.code;
  console.error(`\n[bridge] ╔══════════════════════════════╗`);
  console.error(`[bridge] ║  Room code: ${roomCode.padEnd(18)} ║`);
  console.error(`[bridge] ║  Share this with the other   ║`);
  console.error(`[bridge] ║  machine to join the room.   ║`);
  console.error(`[bridge] ╚══════════════════════════════╝\n`);
} else {
  roomCode = CODE_IN;
}

await connect(roomCode);

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'claude-bridge', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'bridge_status',
      description: 'Show bridge connection status (room code, key exchange, pending messages)',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'bridge_send_message',
      description: 'Send an encrypted message to the peer Claude Code instance across machines',
      inputSchema: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', description: 'Message content to send' },
        },
      },
    },
    {
      name: 'bridge_get_messages',
      description: 'Get all pending incoming messages from the peer Claude Code instance',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'bridge_status') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          role: ROLE,
          roomCode,
          wsConnected: ws?.readyState === WebSocket.OPEN,
          keyExchangeDone: !!shared,
          pendingMessages: inbox.length,
        }, null, 2),
      }],
    };
  }

  if (name === 'bridge_send_message') {
    if (!shared) {
      console.error('[bridge] Waiting for peer key exchange...');
      await waitForKeyExchange();
    }
    const msg = {
      id:              crypto.randomUUID(),
      protocolVersion: 1,
      type:            'chat',
      from:            ROLE,
      timestamp:       Date.now(),
      payload:         { content: String(args.content) },
    };
    const blob = encrypt(msg);
    ws.send(JSON.stringify({ type: 'relay', payload: { dataType: 'encrypted', blob } }));
    return {
      content: [{
        type: 'text',
        text: `✓ Sent (${Buffer.from(blob, 'base64').length} bytes encrypted). Room: ${roomCode}`,
      }],
    };
  }

  if (name === 'bridge_get_messages') {
    const msgs = inbox.splice(0);
    if (msgs.length === 0) {
      return { content: [{ type: 'text', text: 'No pending messages.' }] };
    }
    const text = msgs.map(m =>
      `[${new Date(m.timestamp).toISOString()}] from=${m.from}\n${JSON.stringify(m.payload, null, 2)}`
    ).join('\n\n---\n\n');
    return { content: [{ type: 'text', text }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[bridge] MCP server ready ✓');
