import type { Env } from './env.js';
import { authenticateRequest, type AuthUser } from './middleware.js';

/**
 * Route /admin/* requests.
 */
export async function handleAdmin(request: Request, url: URL, env: Env): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/admin/login' && request.method === 'GET') {
    // If already authenticated, redirect to dashboard
    const user = await authenticateRequest(request, env);
    if (user) {
      return Response.redirect(`${env.ADMIN_ORIGIN}/admin/dashboard`, 302);
    }
    const error = url.searchParams.get('error');
    return htmlResponse(loginPage(error));
  }

  if (path === '/admin/register' && request.method === 'GET') {
    const user = await authenticateRequest(request, env);
    if (user) {
      return Response.redirect(`${env.ADMIN_ORIGIN}/admin/dashboard`, 302);
    }
    const error = url.searchParams.get('error');
    return htmlResponse(registerPage(error));
  }

  if (path === '/admin/dashboard' && request.method === 'GET') {
    const user = await authenticateRequest(request, env);
    if (!user) {
      return Response.redirect(`${env.ADMIN_ORIGIN}/admin/login`, 302);
    }
    return htmlResponse(dashboardPage(user));
  }

  return null;
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

function loginPage(error: string | null): string {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Bridge - Sign In</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    color: #1a1a1a;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    padding: 48px 40px;
    text-align: center;
    max-width: 400px;
    width: 100%;
  }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 32px; }
  .btn-google {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 12px 24px;
    background: #fff;
    border: 1px solid #dadce0;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 500;
    color: #3c4043;
    cursor: pointer;
    text-decoration: none;
    transition: background 0.15s, box-shadow 0.15s;
  }
  .btn-google:hover { background: #f7f8f8; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .btn-google svg { width: 20px; height: 20px; }
  .divider { display: flex; align-items: center; gap: 16px; margin: 24px 0; color: #999; font-size: 13px; }
  .divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid #e5e5e5; }
  .form-group { margin-bottom: 14px; text-align: left; }
  .form-group label { display: block; font-size: 13px; font-weight: 500; color: #555; margin-bottom: 4px; }
  .form-group input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #dadce0;
    border-radius: 6px;
    font-size: 14px;
  }
  .form-group input:focus { outline: none; border-color: #1a73e8; box-shadow: 0 0 0 2px rgba(26,115,232,0.15); }
  .btn-submit {
    width: 100%;
    padding: 10px;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    margin-top: 4px;
  }
  .btn-submit:hover { background: #1557b0; }
  .error { color: #d93025; font-size: 13px; margin-bottom: 16px; background: #fce8e6; padding: 8px 12px; border-radius: 6px; }
  .link { color: #1a73e8; text-decoration: none; font-size: 13px; }
  .link:hover { text-decoration: underline; }
  .footer { margin-top: 20px; }
</style>
</head>
<body>
<div class="card">
  <h1>Claude Bridge</h1>
  <p class="subtitle">E2E encrypted multi-party collaboration</p>
  ${errorHtml}
  <a href="/auth/google" class="btn-google">
    <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
    Sign in with Google
  </a>
  <div class="divider">or</div>
  <form method="POST" action="/auth/login">
    <div class="form-group">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autocomplete="username">
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
    </div>
    <button type="submit" class="btn-submit">Sign in</button>
  </form>
  <div class="footer">
    <a href="/admin/register" class="link">Don't have an account? Register</a>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Register page
// ---------------------------------------------------------------------------

function registerPage(error: string | null): string {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Bridge - Register</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    color: #1a1a1a;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    padding: 48px 40px;
    max-width: 400px;
    width: 100%;
  }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; text-align: center; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; text-align: center; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display: block; font-size: 13px; font-weight: 500; color: #555; margin-bottom: 4px; }
  .form-group input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #dadce0;
    border-radius: 6px;
    font-size: 14px;
  }
  .form-group input:focus { outline: none; border-color: #1a73e8; box-shadow: 0 0 0 2px rgba(26,115,232,0.15); }
  .hint { font-size: 12px; color: #888; margin-top: 4px; }
  .btn-submit {
    width: 100%;
    padding: 10px;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    margin-top: 8px;
  }
  .btn-submit:hover { background: #1557b0; }
  .error { color: #d93025; font-size: 13px; margin-bottom: 16px; background: #fce8e6; padding: 8px 12px; border-radius: 6px; }
  .link { color: #1a73e8; text-decoration: none; font-size: 13px; }
  .link:hover { text-decoration: underline; }
  .footer { margin-top: 20px; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>Create Account</h1>
  <p class="subtitle">Register for Claude Bridge</p>
  ${errorHtml}
  <form method="POST" action="/auth/register">
    <div class="form-group">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required minlength="3" maxlength="30" pattern="[a-zA-Z0-9_-]+" autocomplete="username">
      <p class="hint">3-30 characters, letters, numbers, _ and -</p>
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required minlength="6" autocomplete="new-password">
      <p class="hint">At least 6 characters</p>
    </div>
    <div class="form-group">
      <label for="confirm">Confirm Password</label>
      <input type="password" id="confirm" name="confirm" required minlength="6" autocomplete="new-password">
    </div>
    <button type="submit" class="btn-submit">Create Account</button>
  </form>
  <div class="footer">
    <a href="/admin/login" class="link">Already have an account? Sign in</a>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

function dashboardPage(user: AuthUser): string {
  const avatarHtml = user.picture
    ? `<img src="${escapeHtml(user.picture)}" alt="" class="avatar">`
    : `<div class="avatar avatar-placeholder">${escapeHtml(user.name.charAt(0).toUpperCase())}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Bridge - Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    color: #1a1a1a;
    line-height: 1.5;
  }
  header {
    background: #fff;
    border-bottom: 1px solid #e5e5e5;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  header h1 { font-size: 18px; font-weight: 600; }
  .user-info { display: flex; align-items: center; gap: 12px; font-size: 14px; }
  .avatar { width: 32px; height: 32px; border-radius: 50%; }
  .avatar-placeholder {
    background: #e0e0e0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 14px;
    color: #666;
  }
  .btn-logout {
    padding: 6px 14px;
    background: none;
    border: 1px solid #dadce0;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    color: #555;
  }
  .btn-logout:hover { background: #f5f5f5; }
  main { max-width: 800px; margin: 24px auto; padding: 0 24px; }
  section { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); padding: 24px; margin-bottom: 20px; }
  section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; border-bottom: 1px solid #eee; padding-bottom: 8px; }
  .btn {
    padding: 8px 18px;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    font-weight: 500;
  }
  .btn:hover { background: #1557b0; }
  .btn-danger { background: #d93025; }
  .btn-danger:hover { background: #b3261e; }
  .btn-sm { padding: 4px 12px; font-size: 12px; }
  input[type="text"] {
    padding: 8px 12px;
    border: 1px solid #dadce0;
    border-radius: 6px;
    font-size: 14px;
    width: 240px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { font-weight: 600; color: #555; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .result-box {
    margin-top: 12px;
    padding: 12px 16px;
    background: #f8f9fa;
    border-radius: 8px;
    font-family: "SF Mono", Monaco, Consolas, monospace;
    font-size: 13px;
    word-break: break-all;
    display: none;
  }
  .result-box.visible { display: block; }
  .secret-toggle { cursor: pointer; color: #1a73e8; font-size: 12px; user-select: none; }
  .secret-value { font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 13px; }
  pre.cli {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 16px 20px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre;
  }
  .empty { color: #999; font-size: 14px; font-style: italic; }
  .row { display: flex; align-items: center; gap: 10px; }
</style>
</head>
<body>
<header>
  <h1>Claude Bridge</h1>
  <div class="user-info">
    ${avatarHtml}
    <span>${escapeHtml(user.name)} (${escapeHtml(user.email)})</span>
    <form method="POST" action="/auth/logout" style="margin:0">
      <button type="submit" class="btn-logout">Sign out</button>
    </form>
  </div>
</header>
<main>

<!-- Create Room -->
<section>
  <h2>Create Room</h2>
  <button class="btn" onclick="createRoom()">Create New Room</button>
  <div id="room-result" class="result-box"></div>
</section>

<!-- My Rooms -->
<section>
  <h2>My Rooms</h2>
  <div id="rooms-list"><p class="empty">Loading...</p></div>
</section>

<!-- API Tokens -->
<section>
  <h2>API Tokens</h2>
  <div class="row" style="margin-bottom: 12px;">
    <input type="text" id="token-label" placeholder="Token label (e.g. laptop)">
    <button class="btn" onclick="createToken()">Create Token</button>
  </div>
  <div id="token-result" class="result-box"></div>
  <div id="tokens-list"><p class="empty">Loading...</p></div>
</section>

<!-- CLI Quick Start -->
<section>
  <h2>CLI Quick Start</h2>
  <pre class="cli"># Login with your API token
claude-bridge login &lt;your-token&gt;

# Host a room (creates room + installs MCP server)
claude-bridge host

# Join with room code and secret
claude-bridge mcp-install --role host --code &lt;CODE&gt; --secret &lt;SECRET&gt; --name &lt;NAME&gt;</pre>
</section>

</main>

<script>
async function createRoom() {
  const res = await fetch('/api/room/create', { method: 'POST' });
  if (!res.ok) { alert('Failed to create room'); return; }
  const data = await res.json();
  const el = document.getElementById('room-result');
  el.classList.add('visible');
  el.innerHTML = '<strong>Room Code:</strong> ' + esc(data.code) +
    '<br><strong>Join Secret:</strong> ' + esc(data.joinSecret);
  loadRooms();
}

async function loadRooms() {
  const res = await fetch('/api/rooms');
  if (!res.ok) return;
  const data = await res.json();
  const el = document.getElementById('rooms-list');
  if (!data.rooms.length) {
    el.innerHTML = '<p class="empty">No rooms yet. Create one above.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Code</th><th>Join Secret</th><th>Created</th></tr></thead><tbody>';
  for (const r of data.rooms) {
    const date = new Date(r.createdAt).toLocaleDateString();
    html += '<tr><td><strong>' + esc(r.code) + '</strong></td>' +
      '<td><span class="secret-value" data-secret="' + esc(r.joinSecret) + '">' +
      dots(r.joinSecret.length) + '</span> ' +
      '<span class="secret-toggle" onclick="toggleSecret(this)">[show]</span></td>' +
      '<td>' + esc(date) + '</td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function createToken() {
  const label = document.getElementById('token-label').value.trim() || 'Untitled';
  const res = await fetch('/api/tokens/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) { alert('Failed to create token'); return; }
  const data = await res.json();
  const el = document.getElementById('token-result');
  el.classList.add('visible');
  el.innerHTML = '<strong>Token created!</strong> Copy it now (you will not see it again):<br>' +
    '<code>' + esc(data.token) + '</code>';
  document.getElementById('token-label').value = '';
  loadTokens();
}

async function loadTokens() {
  const res = await fetch('/api/tokens');
  if (!res.ok) return;
  const data = await res.json();
  const el = document.getElementById('tokens-list');
  if (!data.tokens.length) {
    el.innerHTML = '<p class="empty">No API tokens yet.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Label</th><th>Token</th><th>Created</th><th></th></tr></thead><tbody>';
  for (const t of data.tokens) {
    const date = new Date(t.createdAt).toLocaleDateString();
    html += '<tr><td>' + esc(t.label) + '</td>' +
      '<td class="secret-value">...' + esc(t.last4) + '</td>' +
      '<td>' + esc(date) + '</td>' +
      '<td><button class="btn btn-danger btn-sm" onclick="deleteToken(&quot;' + esc(t.id) + '&quot;)">Delete</button></td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function deleteToken(id) {
  if (!confirm('Delete this token? This cannot be undone.')) return;
  const res = await fetch('/api/tokens/' + id, { method: 'DELETE' });
  if (!res.ok) { alert('Failed to delete token'); return; }
  loadTokens();
}

function toggleSecret(el) {
  const span = el.previousElementSibling;
  const secret = span.getAttribute('data-secret');
  if (el.textContent === '[show]') {
    span.textContent = secret;
    el.textContent = '[hide]';
  } else {
    span.textContent = dots(secret.length);
    el.textContent = '[show]';
  }
}

function dots(n) { return '\\u2022'.repeat(Math.min(n, 16)); }

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Load on page init
loadRooms();
loadTokens();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
