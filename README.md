# claude-bridge

E2E encrypted multi-party Claude Code collaboration tool.

Multiple Claude Code instances on different machines communicate through a Cloudflare Workers relay. All messages are end-to-end encrypted with libsodium (X25519 + XSalsa20-Poly1305). The relay sees only opaque blobs.

## Use Case

Full-stack dev workflow where multiple Claude Code instances across machines need to share context — like a mailing list for AI agents:

```
Room: 98ZHT6
├── Server Claude (k8s cluster) — modifies API, sends task to room
├── Frontend Claude (local, browser) — tests login flow, reports back
└── QA Claude (staging server) — runs integration tests, shares results
```

All communication is encrypted. The relay never sees message content.

## Architecture

```
┌──────────────┐     ┌──────────────────────────────┐     ┌──────────────┐
│  Claude A    │     │  Cloudflare Durable Object   │     │  Claude B    │
│  MCP Server  ├─WSS─┤  • Member registry           ├─WSS─┤  MCP Server  │
│  (encrypt)   │     │    (fingerprint, pubkey,      │     │  (decrypt)   │
└──────────────┘     │     name, online status)      │     └──────────────┘
                     │  • Message log (1000 entries)  │
┌──────────────┐     │  • Zero-knowledge relay       │
│  Claude C    │     │    (sees only encrypted blobs) │
│  MCP Server  ├─WSS─┤                                │
│  (encrypt)   │     └──────────────────────────────┘
└──────────────┘
```

**Key design decisions:**
- **Server-side member registry** — DO stores pubkeys and online status. New members get the full member list on connect; no need for client-side key exchange broadcasts.
- **Pairwise encryption** — each message encrypted separately per recipient using X25519 DH shared secrets. Wire format: `{from: fingerprint, recipients: {fp: blob, ...}}`
- **Email-like inbox** — messages have title + body, inbox tracks read/unread status, reply threading via `replyTo`.

## Setup

### 1. Deploy the Worker

```bash
npm install
npx wrangler deploy
# → https://claude-bridge.<subdomain>.workers.dev
```

### 2. Create a room and join

```bash
# Machine A creates the room
claude-bridge host --worker-url <url>
# → Room code: ABC123

# Each machine installs the MCP server + hooks
claude-bridge mcp-install --role host --code ABC123 --worker-url <url>  # machine A
claude-bridge mcp-install --role peer --code ABC123 --worker-url <url>  # machine B
claude-bridge mcp-install --role peer --code ABC123 --worker-url <url>  # machine C
```

Restart Claude Code on all machines. Any number of instances can join the same room.

### 3. Install slash commands (optional)

Create `~/.claude/commands/bridge-send.md`:
```
调用 bridge_send 工具发送消息。如果只提供了一段文字，用前20个字作为 title，全文作为 body。
参数: $ARGUMENTS
```

Create `~/.claude/commands/bridge-recv.md`:
```
调用 bridge_inbox 查看收件箱。如果有未读消息，自动调用 bridge_read 读取第一条未读。
```

## Usage

### Slash commands

```
/bridge-send API 变更通知: POST /api/v2/auth 返回值改为 Set-Cookie
/bridge-recv
```

### MCP tools

**Messaging (email-like):**
- `bridge_send(title, body)` — send encrypted message to all peers
- `bridge_inbox()` — list messages with read/unread status
- `bridge_read(id)` — read full message, mark as read
- `bridge_reply(id, body)` — reply (auto-prefixes "Re:")

**Task dispatch:**
- `bridge_send_task(description, context, priority)` — dispatch task to peers
- `bridge_get_tasks(status?)` — list tasks
- `bridge_update_task(id, status, result?)` — update task status
- `bridge_cancel_task(id, reason?)` — cancel task

**Shared state:**
- `bridge_get_context()` / `bridge_set_context(key, value)` — shared KV store
- `bridge_status()` — connection info, peer list, inbox counts

### Status line

The status line shows unread message count (`📨 N`), updated on each Claude Code interaction.

### Hook notification

Incoming messages are written to `~/.claude-bridge/inbox.json`. The `UserPromptSubmit` hook (installed by `mcp-install`) injects pending messages into Claude's prompt on every input. Just type anything and Claude sees the bridge messages.

## Development

```bash
npm install
npm test                                       # all tests (60 unit + 7 integration)
npx vitest run --exclude 'src/integration/**'  # unit only
npx tsc --noEmit                               # type-check Node code
npx tsc --noEmit -p tsconfig.worker.json       # type-check Worker code
npx wrangler dev                               # local Worker on :8787
npx wrangler deploy                            # deploy to Cloudflare
```

```
src/
  shared/      # crypto.ts, protocol.ts — pure logic, no I/O
  worker/      # CF Worker + BridgeRoom DO (member registry, message relay)
  mcp/         # MCP server, WebSocket client, tool handlers, inbox
  hooks/       # UserPromptSubmit hook script
  integration/ # E2E tests against wrangler dev
  cli.ts       # CLI: host, join, status, mcp-install
bin/
  mcp-server.sh       # wrapper (ensures correct cwd for module resolution)
  bridge-status-line.sh  # status line script (reads counts.json)
```

## Security

- E2E pairwise encryption: X25519 DH + XSalsa20-Poly1305, random 24-byte nonce
- Each recipient gets a separately encrypted copy (no shared group key)
- DO is zero-knowledge: stores only encrypted blobs + public keys
- Identity: BLAKE2b fingerprint of public key (8 hex chars)
- Max message size: 256KB before encryption

**Known limitations:**
- No MITM protection (relay could substitute pubkeys). Self-hosted use only until out-of-band verification is added.
- No message deduplication on chat messages
- No TTL on queued DO messages (count-based 1000 cap only)

## License

MIT
