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

  if (path === '/auth/register' && request.method === 'POST') {
    return handleRegister(request, env);
  }

  if (path === '/auth/login' && request.method === 'POST') {
    return handleLocalLogin(request, env);
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

  return createSessionAndRedirect(
    {
      userId: payload.sub,
      email: payload.email,
      name: payload.name ?? payload.email,
      picture: payload.picture,
    },
    env,
  );
}

// ---------------------------------------------------------------------------
// Session creation helper (shared by Google OAuth and local auth)
// ---------------------------------------------------------------------------

async function createSessionAndRedirect(user: { userId: string; email: string; name: string; picture?: string }, env: Env): Promise<Response> {
  const sessionToken = generateToken(32);
  const ttlSeconds = 7 * 24 * 60 * 60;
  await env.SESSIONS.put(`session:${sessionToken}`, JSON.stringify(user), {
    expirationTtl: ttlSeconds,
  });

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

// ---------------------------------------------------------------------------
// Password hashing (PBKDF2 via Web Crypto API)
// ---------------------------------------------------------------------------

async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

function encodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBytes(b64: string): Uint8Array {
  return new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
}

// ---------------------------------------------------------------------------
// POST /auth/register — create local account
// ---------------------------------------------------------------------------

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const username = (formData.get('username') as string ?? '').trim().toLowerCase();
  const password = formData.get('password') as string ?? '';
  const confirm = formData.get('confirm') as string ?? '';

  if (!username || username.length < 3 || username.length > 30) {
    return Response.redirect(`${env.ADMIN_ORIGIN}/admin/register?error=Username+must+be+3-30+characters`, 302);
  }
  if (!/^[a-z0-9_-]+$/.test(username)) {
    return Response.redirect(`${env.ADMIN_ORIGIN}/admin/register?error=Username+can+only+contain+letters+numbers+_+-`, 302);
  }
  if (password.length < 6) {
    return Response.redirect(`${env.ADMIN_ORIGIN}/admin/register?error=Password+must+be+at+least+6+characters`, 302);
  }
  if (password !== confirm) {
    return Response.redirect(`${env.ADMIN_ORIGIN}/admin/register?error=Passwords+do+not+match`, 302);
  }

  // Check if username taken
  const existing = await env.SESSIONS.get(`user:${username}`);
  if (existing) {
    return Response.redirect(`${env.ADMIN_ORIGIN}/admin/register?error=Username+already+taken`, 302);
  }

  // Hash password and store
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);

  const userData = {
    userId: `local:${username}`,
    email: username,
    name: username,
    passwordHash,
    salt: encodeBytes(salt),
    createdAt: Date.now(),
  };
  await env.SESSIONS.put(`user:${username}`, JSON.stringify(userData));

  return createSessionAndRedirect(
    { userId: userData.userId, email: username, name: username },
    env,
  );
}

// ---------------------------------------------------------------------------
// POST /auth/login — local password login
// ---------------------------------------------------------------------------

async function handleLocalLogin(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const username = (formData.get('username') as string ?? '').trim().toLowerCase();
  const password = formData.get('password') as string ?? '';

  if (!username || !password) {
    return Response.redirect(`${env.ADMIN_ORIGIN}/admin/login?error=Username+and+password+required`, 302);
  }

  const raw = await env.SESSIONS.get(`user:${username}`);
  if (!raw) {
    return Response.redirect(`${env.ADMIN_ORIGIN}/admin/login?error=Invalid+username+or+password`, 302);
  }

  const userData = JSON.parse(raw) as {
    userId: string;
    email: string;
    name: string;
    passwordHash: string;
    salt: string;
  };

  const salt = decodeBytes(userData.salt);
  const hash = await hashPassword(password, salt);
  if (hash !== userData.passwordHash) {
    return Response.redirect(`${env.ADMIN_ORIGIN}/admin/login?error=Invalid+username+or+password`, 302);
  }

  return createSessionAndRedirect(
    { userId: userData.userId, email: userData.email, name: userData.name },
    env,
  );
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
