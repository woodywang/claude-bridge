export { BridgeRoom } from './durable-object.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  ROOM: DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// Room code generation
// ---------------------------------------------------------------------------

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length];
  }
  return code;
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'claude-bridge' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create room
    if (path === '/room/create' && request.method === 'POST') {
      const code = generateRoomCode();
      return new Response(JSON.stringify({ code }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade to room
    const wsMatch = path.match(/^\/room\/([A-Z0-9]{6})\/ws$/);
    if (wsMatch) {
      const code = wsMatch[1];
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
