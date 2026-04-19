import type { Env } from './env.js';

export interface AuthUser {
  userId: string;
  email: string;
  name: string;
  picture?: string;
}

/**
 * Extract user from session cookie.
 */
export async function authenticateRequest(request: Request, env: Env): Promise<AuthUser | null> {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)__bridge_session=([a-f0-9]+)/);
  if (match) {
    const token = match[1];
    const data = await env.SESSIONS.get(`session:${token}`, 'json');
    if (data) return data as AuthUser;
  }

  return null;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function generateToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}
