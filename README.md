# claude-bridge

E2E encrypted multi-party Claude Code collaboration tool.

Multiple Claude Code instances on different machines communicate through a Cloudflare Workers relay. All messages are end-to-end encrypted with libsodium (X25519 + XSalsa20-Poly1305). The relay sees only opaque blobs.

## Use Case

Full-stack dev workflow where multiple Claude Code instances across machines need to coordinate:

```
Room: 98ZHT6
├── Alice (k8s cluster)  — modifies API, sends task to room
├── Bob   (local dev)    — tests login flow, replies with CC
└── Charlie (staging)    — runs integration tests, shares results
```

Each instance joins with a **required alias** (e.g. Alice, Bob, Charlie). All communication is encrypted. The relay never sees message content.

## Architecture

```
┌──────────────┐     ┌──────────────────────────────┐     ┌──────────────┐
│  Alice       │     │  Cloudflare Durable Object   │     │  Bob         │
│  MCP Server  ├─WSS─┤  • Member registry           ├─WSS─┤  MCP Server  │
│  (encrypt)   │     │    (fingerprint, pubkey,      │     │  (decrypt)   │
└──────────────┘     │     name, online status)      │     └──────────────┘
                     │  • Message log (1000 entries)  │
┌──────────────┐     │  • Zero-knowledge relay       │
│  Charlie     │     │    (sees only encrypted blobs) │
│  MCP Server  ├─WSS─┤                                │
│  (encrypt)   │     └──────────────────────────────┘
└──────────────┘
```

**Key design decisions:**
- **Server-side member registry** — DO stores pubkeys, aliases, and online status. New members get the full member list on connect.
- **Pairwise encryption** — each message encrypted separately per recipient using X25519 DH shared secrets. Wire format: `{from: fingerprint, recipients: {fp: blob, ...}}`
- **Targeted replies with CC** — replies go only to the original sender; optionally CC other peers with additional context.
- **Draft-confirm workflow** — replies are drafted by a sub-agent, presented to the human for review, and sent only after confirmation.
- **Sub-agent processing** — incoming messages are processed in a sub-agent to keep the main conversation context clean.

## Setup

### 1. Deploy the Worker

```bash
npm install

# Create KV namespace
npx wrangler kv:namespace create SESSIONS
# → Update the id in wrangler.toml [[kv_namespaces]]

# Set Google OAuth secrets
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# Deploy
npx wrangler deploy
# → https://claude-bridge.<subdomain>.workers.dev
```

Google OAuth setup: create credentials at [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Set authorized redirect URI to `https://claude-bridge.<subdomain>.workers.dev/auth/callback`.

### 2. Login and create a room

```bash
# Login via web dashboard → get API token → authenticate CLI
claude-bridge login <api-token>

# Create a room (requires authentication)
claude-bridge host
# → Room code: ABC123
# → Join secret: a1b2c3d4...
```

### 3. Join the room

```bash
# Each machine installs the MCP server + hooks
claude-bridge mcp-install --role host --code ABC123 --secret <join-secret> --name Alice
claude-bridge mcp-install --role peer --code ABC123 --secret <join-secret> --name Bob
claude-bridge mcp-install --role peer --code ABC123 --secret <join-secret> --name Charlie
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

## MCP Tools

### Room

| Tool | Description |
|------|-------------|
| `bridge_status()` | Connection info, peer list, inbox counts |
| `bridge_members()` | List all instances with name, fingerprint, role |

### Messaging

| Tool | Description |
|------|-------------|
| `bridge_send(title, body, to?)` | Send to specific peers or broadcast to all |
| `bridge_inbox()` | List messages with read/unread status, sender names (sorted by server seqId) |
| `bridge_read(id)` | Read full message (does NOT mark as read) |
| `bridge_mark_read(ids)` | Mark messages as read after human review |
| `bridge_draft_reply(id, draft_body, suggested_cc?)` | Draft reply for human review (does NOT send) |
| `bridge_reply(id, body, cc?, cc_context?)` | Send confirmed reply to sender, optionally CC others |

### Task Dispatch

| Tool | Description |
|------|-------------|
| `bridge_send_task(description, context, priority)` | Dispatch task to all peers |
| `bridge_get_tasks(status?)` | List tasks with optional filter |
| `bridge_update_task(id, status, result?)` | Update task and notify peers |
| `bridge_cancel_task(id, reason?)` | Cancel task and notify peers |

### Shared State

| Tool | Description |
|------|-------------|
| `bridge_get_context()` | Get the shared key-value store |
| `bridge_set_context(key, value)` | Set a key-value pair and sync to all peers |

## Reply Workflow

Replies follow a **draft → confirm → send** flow to ensure the human stays in control:

```
1. Hook fires on new messages
   ↓
2. Sub-agent reads messages (bridge_read)
   ↓
3. Sub-agent drafts reply (bridge_draft_reply)
   → returns draft + CC options to main agent
   ↓
4. Main agent presents draft to human
   → human confirms, edits, or chooses CC recipients
   ↓
5. Main agent sends (bridge_reply) + marks read (bridge_mark_read)
   → reply to original sender (targeted, not broadcast)
   → CC copies to specified peers with extra context
```

**CC example:** Bob replies to Alice's message and CCs Charlie with context:
```
bridge_reply(
  id: "abc12345",
  body: "API endpoints ready, see /api/v2/auth",
  cc: ["Charlie"],
  cc_context: "Bob is handling the API work; this affects your DB migration"
)
```
Alice receives the reply. Charlie receives a CC copy with the context prepended.

## Hook Notification

Incoming messages are written to `~/.claude-bridge/inbox.json`. The `UserPromptSubmit` hook (installed by `mcp-install`) reads pending messages on every Claude Code input and injects them into the prompt. The hook instructs Claude to process messages in a **sub-agent** to keep the main context clean.

The status line shows unread message count (`📨 N`), updated on each interaction.

## Development

```bash
npm install
npm run build                                  # compile TypeScript
npm test                                       # all tests (63 unit + integration)
npx vitest run --exclude 'src/integration/**'  # unit only
npx tsc --noEmit                               # type-check Node code
npx tsc --noEmit -p tsconfig.worker.json       # type-check Worker code
npx wrangler dev                               # local Worker on :8787
```

```
src/
  shared/      # crypto.ts, protocol.ts — pure logic, no I/O
  worker/      # CF Worker: auth, API, pages, BridgeRoom DO (relay)
  mcp/         # MCP server, tools, WebSocket client, inbox
  hooks/       # UserPromptSubmit hook script
  integration/ # E2E tests against wrangler dev
  cli.ts       # CLI: host, join, status, mcp-install
bin/
  mcp-server.sh          # wrapper script
  bridge-status-line.sh  # status line script (reads counts.json)
```

## Security

**Authentication:**
- Google OAuth for web login, KV-backed sessions (7-day TTL, HttpOnly cookies)
- API tokens for CLI (365-day TTL, mode 0600 on disk)
- Room creation requires authentication; join requires room-specific secret
- DO remains zero-knowledge — auth is enforced at the Worker edge

**Encryption:**
- E2E pairwise encryption: X25519 DH + XSalsa20-Poly1305, random 24-byte nonce
- Each recipient gets a separately encrypted copy (no shared group key)
- Targeted replies: only the intended recipient(s) can decrypt
- Persistent identity: keypair saved to `~/.claude-bridge/identity-<name>.json` (mode 0600)
- Server-assigned monotonic seqId for message ordering (no client clock dependency)

**Known limitations:**
- No MITM protection (relay could substitute pubkeys). Self-hosted only until out-of-band verification is added.
- No TTL on queued DO messages (count-based 1000 cap only)

## License

MIT
