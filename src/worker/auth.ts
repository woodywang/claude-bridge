import type { Env } from './env.js';
import { authenticateRequest, generateToken } from './middleware.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'openid email profile';

/**
 * Route /auth/* requests.
 */
export async function handleAuth(request: Request, url: URL, env: Env): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/auth/google' && request.method === 'GET') {
    return handleGoogleRedirect(env);
  }

  if (path === '/auth/callback' && request.method === 'GET') {
    return handleCallback(url, env);
  }

  if (path === '/auth/logout' && request.method === 'POST') {
    return handleLogout(request, env);
  }

  return null;
}

/**
 * GET /auth/google — redirect to Google consent screen.
 */
async function handleGoogleRedirect(env: Env): Promise<Response> {
  const state = generateToken(16);
  await env.SESSIONS.put(`oauth_state:${state}`, '1', { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state,
    access_type: 'online',
    prompt: 'select_account',
  });

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
}

/**
 * GET /auth/callback — exchange code for tokens, create session.
 */
async function handleCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  // Validate state
  const stateData = await env.SESSIONS.get(`oauth_state:${state}`);
  if (!stateData) {
    return new Response('Invalid or expired state', { status: 400 });
  }
  await env.SESSIONS.delete(`oauth_state:${state}`);

  // Exchange code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    return new Response('Token exchange failed', { status: 502 });
  }

  const tokenData = (await tokenRes.json()) as { id_token?: string };
  if (!tokenData.id_token) {
    return new Response('No id_token in response', { status: 502 });
  }

  // Decode JWT payload (no signature verification needed — direct from Google over HTTPS)
  const parts = tokenData.id_token.split('.');
  if (parts.length !== 3) {
    return new Response('Malformed id_token', { status: 502 });
  }

  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
    sub: string;
    email: string;
    name?: string;
    picture?: string;
  };

  const user = {
    userId: payload.sub,
    email: payload.email,
    name: payload.name ?? payload.email,
    picture: payload.picture,
  };

  // Create session
  const sessionToken = generateToken(32); // 64 hex chars
  const ttlSeconds = 7 * 24 * 60 * 60; // 7 days
  await env.SESSIONS.put(`session:${sessionToken}`, JSON.stringify(user), {
    expirationTtl: ttlSeconds,
  });

  // Set cookie — omit Secure flag for local dev (http)
  const isLocal = env.ADMIN_ORIGIN.startsWith('http://');
  const securePart = isLocal ? '' : ' Secure;';
  const cookie = `__bridge_session=${sessionToken}; Path=/; HttpOnly;${securePart} SameSite=Lax; Max-Age=${ttlSeconds}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/admin/dashboard',
      'Set-Cookie': cookie,
    },
  });
}

/**
 * POST /auth/logout — clear session.
 */
async function handleLogout(request: Request, env: Env): Promise<Response> {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)__bridge_session=([a-f0-9]+)/);
  if (match) {
    await env.SESSIONS.delete(`session:${match[1]}`);
  }

  const isLocal = env.ADMIN_ORIGIN.startsWith('http://');
  const securePart = isLocal ? '' : ' Secure;';
  const clearCookie = `__bridge_session=; Path=/; HttpOnly;${securePart} SameSite=Lax; Max-Age=0`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/admin/login',
      'Set-Cookie': clearCookie,
    },
  });
}
