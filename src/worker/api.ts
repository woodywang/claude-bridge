import type { Env } from './env.js';
import { authenticateRequest, generateToken, jsonResponse, type AuthUser } from './middleware.js';

interface RoomRecord {
  code: string;
  joinSecret: string;
  creatorUserId: string;
  createdAt: string;
}

/**
 * Route /api/* requests. All require authentication.
 */
export async function handleApi(request: Request, url: URL, env: Env): Promise<Response | null> {
  const path = url.pathname;

  const user = await authenticateRequest(request, env);
  if (!user) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (path === '/api/room/create' && request.method === 'POST') {
    return handleRoomCreate(user, env);
  }

  if (path === '/api/rooms' && request.method === 'GET') {
    return handleRoomList(user, env);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------

function generateRoomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const length = 6;
  const bytes = new Uint8Array(length * 2);
  crypto.getRandomValues(bytes);
  const maxValid = Math.floor(256 / chars.length) * chars.length;
  let code = '';
  for (const byte of bytes) {
    if (code.length >= length) break;
    if (byte < maxValid) {
      code += chars[byte % chars.length];
    }
  }
  while (code.length < length) {
    const extra = new Uint8Array(1);
    crypto.getRandomValues(extra);
    if (extra[0] < maxValid) {
      code += chars[extra[0] % chars.length];
    }
  }
  return code;
}

async function handleRoomCreate(user: AuthUser, env: Env): Promise<Response> {
  const code = generateRoomCode();
  const joinSecret = generateToken(32); // 64 hex chars

  const roomRecord: RoomRecord = {
    code,
    joinSecret,
    creatorUserId: user.userId,
    createdAt: new Date().toISOString(),
  };

  // Store room record (30-day TTL)
  await env.SESSIONS.put(`room:${code}`, JSON.stringify(roomRecord), {
    expirationTtl: 30 * 24 * 60 * 60,
  });

  // Append to user's room list
  const roomList = ((await env.SESSIONS.get(`user_rooms:${user.userId}`, 'json')) ?? []) as string[];
  roomList.push(code);
  await env.SESSIONS.put(`user_rooms:${user.userId}`, JSON.stringify(roomList));

  return jsonResponse({ code, joinSecret });
}

async function handleRoomList(user: AuthUser, env: Env): Promise<Response> {
  const roomCodes = ((await env.SESSIONS.get(`user_rooms:${user.userId}`, 'json')) ?? []) as string[];

  const rooms: RoomRecord[] = [];
  for (const code of roomCodes) {
    const record = await env.SESSIONS.get(`room:${code}`, 'json');
    if (record) {
      rooms.push(record as RoomRecord);
    }
  }

  return jsonResponse({ rooms });
}
