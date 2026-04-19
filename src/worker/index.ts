export { BridgeRoom } from './durable-object.js';
export type { Env } from './env.js';
import type { Env } from './env.js';
import { handleAuth } from './auth.js';
import { handleApi } from './api.js';
import { landingPage, handleAdmin } from './pages.js';
import { jsonResponse } from './middleware.js';

// ---------------------------------------------------------------------------
// Room code generation
// ---------------------------------------------------------------------------

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH * 2); // extra bytes for rejection sampling
  crypto.getRandomValues(bytes);
  let code = '';
  const maxValid = Math.floor(256 / ROOM_CODE_CHARS.length) * ROOM_CODE_CHARS.length; // 252
  for (const byte of bytes) {
    if (code.length >= ROOM_CODE_LENGTH) break;
    if (byte < maxValid) {
      code += ROOM_CODE_CHARS[byte % ROOM_CODE_CHARS.length];
    }
    // else: reject this byte (bias zone)
  }
  // Fallback: if rejection sampling used all bytes (extremely unlikely), fill remainder
  while (code.length < ROOM_CODE_LENGTH) {
    const extra = new Uint8Array(1);
    crypto.getRandomValues(extra);
    if (extra[0] < maxValid) {
      code += ROOM_CODE_CHARS[extra[0] % ROOM_CODE_CHARS.length];
    }
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

    // Landing page
    if (path === '/') {
      return new Response(landingPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Health check
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'claude-bridge' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // -----------------------------------------------------------------------
    // Auth routes (/auth/*)
    // -----------------------------------------------------------------------
    if (path.startsWith('/auth/')) {
      const res = await handleAuth(request, url, env);
      if (res) return res;
    }

    // -----------------------------------------------------------------------
    // Admin pages (/admin/*)
    // -----------------------------------------------------------------------
    if (path.startsWith('/admin/')) {
      const res = await handleAdmin(request, url, env);
      if (res) return res;
    }

    // -----------------------------------------------------------------------
    // API routes (/api/*)
    // -----------------------------------------------------------------------
    if (path.startsWith('/api/')) {
      const res = await handleApi(request, url, env);
      if (res) return res;
    }

    // -----------------------------------------------------------------------
    // Legacy room create — direct callers to web dashboard
    // -----------------------------------------------------------------------
    if (path === '/room/create' && request.method === 'POST') {
      return jsonResponse(
        { error: 'This endpoint is deprecated. Use the web dashboard at /admin/dashboard to create rooms.' },
        401,
      );
    }

    // GET /room/:code/members — return member list from DO
    const membersMatch = path.match(/^\/room\/([A-Z0-9]{6})\/members$/);
    if (membersMatch && request.method === 'GET') {
      const code = membersMatch[1];
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      return stub.fetch(new Request(new URL('/members', request.url).toString()));
    }

    // WebSocket upgrade to room — with join secret validation
    const wsMatch = path.match(/^\/room\/([A-Z0-9]{6})\/ws$/);
    if (wsMatch) {
      const code = wsMatch[1];

      // Validate join secret if the room was created through the dashboard
      const roomData = await env.SESSIONS.get(`room:${code}`, 'json') as { joinSecret: string } | null;
      if (roomData) {
        const secret = url.searchParams.get('secret');
        if (secret !== roomData.joinSecret) {
          return new Response('Invalid join secret', { status: 403 });
        }
      }
      // If no room data in KV (legacy/local dev), allow without secret

      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
