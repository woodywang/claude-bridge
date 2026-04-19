import type { Env } from './env.js';
import { authenticateRequest, generateToken, jsonResponse, type AuthUser } from './middleware.js';

interface RoomRecord {
  code: string;
  joinSecret: string;
  creatorUserId: string;
  createdAt: string;
}

interface TokenRecord {
  tokenPrefix: string;
  label: string;
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

  if (path === '/api/tokens/create' && request.method === 'POST') {
    return handleTokenCreate(request, user, env);
  }

  if (path === '/api/tokens' && request.method === 'GET') {
    return handleTokenList(user, env);
  }

  const tokenDeleteMatch = path.match(/^\/api\/tokens\/([a-f0-9]{16})$/);
  if (tokenDeleteMatch && request.method === 'DELETE') {
    return handleTokenDelete(tokenDeleteMatch[1], user, env);
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

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function handleTokenCreate(request: Request, user: AuthUser, env: Env): Promise<Response> {
  let body: { label?: string };
  try {
    body = (await request.json()) as { label?: string };
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const label = body.label ?? 'Untitled';
  const token = generateToken(32); // 64 hex chars
  const tokenPrefix = token.slice(0, 16);

  // Store the API token → user mapping (365-day TTL)
  await env.SESSIONS.put(`apitoken:${token}`, JSON.stringify(user), {
    expirationTtl: 365 * 24 * 60 * 60,
  });

  // Store reference for listing: usertoken:<userId>:<prefix> → full token
  await env.SESSIONS.put(`usertoken:${user.userId}:${tokenPrefix}`, token, {
    expirationTtl: 365 * 24 * 60 * 60,
  });

  // Append to user's token list
  const tokenList = ((await env.SESSIONS.get(`user_tokens:${user.userId}`, 'json')) ?? []) as TokenRecord[];
  tokenList.push({
    tokenPrefix,
    label,
    createdAt: new Date().toISOString(),
  });
  await env.SESSIONS.put(`user_tokens:${user.userId}`, JSON.stringify(tokenList));

  return jsonResponse({ token, label });
}

async function handleTokenList(user: AuthUser, env: Env): Promise<Response> {
  const tokenList = ((await env.SESSIONS.get(`user_tokens:${user.userId}`, 'json')) ?? []) as TokenRecord[];

  // Return label, createdAt, and last 4 chars (never full token)
  const tokens = tokenList.map(t => ({
    id: t.tokenPrefix,
    label: t.label,
    createdAt: t.createdAt,
    last4: t.tokenPrefix.slice(-4),
  }));

  return jsonResponse({ email: user.email, name: user.name, tokens });
}

async function handleTokenDelete(prefix: string, user: AuthUser, env: Env): Promise<Response> {
  // Look up the full token
  const fullToken = await env.SESSIONS.get(`usertoken:${user.userId}:${prefix}`);
  if (!fullToken) {
    return jsonResponse({ error: 'Token not found' }, 404);
  }

  // Delete both KV keys
  await env.SESSIONS.delete(`apitoken:${fullToken}`);
  await env.SESSIONS.delete(`usertoken:${user.userId}:${prefix}`);

  // Remove from user's token list
  const tokenList = ((await env.SESSIONS.get(`user_tokens:${user.userId}`, 'json')) ?? []) as TokenRecord[];
  const filtered = tokenList.filter(t => t.tokenPrefix !== prefix);
  await env.SESSIONS.put(`user_tokens:${user.userId}`, JSON.stringify(filtered));

  return jsonResponse({ ok: true });
}
