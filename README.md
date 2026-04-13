# claude-bridge

E2E encrypted cross-machine Claude Code collaboration tool.

Two Claude Code instances on different machines communicate through a Cloudflare Workers relay. All messages are end-to-end encrypted with libsodium (X25519 + XSalsa20-Poly1305). The relay sees only opaque blobs.

## Use Case

Full-stack dev workflow where backend Claude Code (remote server, k8s) and frontend Claude Code (local machine, browser) need to share context:

- Server Claude modifies an API → sends task + context to local Claude
- Local Claude tests the frontend → sends result back
- Shared context key-value store syncs between both sides

No more manually copy-pasting API diffs or re-explaining context.

## Architecture

```
┌──────────────────┐        ┌─────────────────┐        ┌──────────────────┐
│  Remote Machine  │        │  Cloudflare     │        │  Local Machine   │
│                  │        │                 │        │                  │
│  Claude Code     │        │  Worker         │        │  Claude Code     │
│    ↕ stdio       │        │    ↕            │        │    ↕ stdio       │
│  MCP Server ←────┼──WSS──→│  Durable Object │←──WSS──┼──→ MCP Server   │
│                  │        │  (relay only)   │        │                  │
│  libsodium       │        │  zero-knowledge │        │  libsodium       │
└──────────────────┘        └─────────────────┘        └──────────────────┘
```

- **Cloudflare Worker + Durable Object**: WebSocket relay, Hibernation API, zero-knowledge
- **MCP Server (single process)**: stdio transport for Claude Code + WebSocket to CF DO
- **Protocol**: Control plane (unencrypted: sync, key exchange) + Data plane (encrypted: messages)

## Setup

### 1. Deploy the Worker

```bash
npm install
npx wrangler deploy
```

Note the Worker URL (e.g. `https://claude-bridge.<subdomain>.workers.dev`).

### 2. Pair two machines

On machine A:

```bash
claude-bridge host --worker-url <url>
# → Room code: ABC123
```

On both machines:

```bash
claude-bridge mcp-install --role host --code ABC123 --worker-url <url>  # machine A
claude-bridge mcp-install --role peer --code ABC123 --worker-url <url>  # machine B
```

Then restart Claude Code on both machines.

## Usage

Inside a Claude Code session on either machine:

### Slash commands

```
/bridge-send 任务：测试前端登录流程
/bridge-recv
```

### MCP tools

- `bridge_status` — connection status
- `bridge_send_message(content)` / `bridge_get_messages()` — chat
- `bridge_send_task(description, context, priority)` / `bridge_get_tasks()` / `bridge_update_task(id, status, result?)` / `bridge_cancel_task(id, reason?)`
- `bridge_get_context()` / `bridge_set_context(key, value)` — shared KV store

### How incoming messages surface

Incoming messages are written to `~/.claude-bridge/inbox.json`. The `UserPromptSubmit` hook (installed by `mcp-install`) reads the inbox on every prompt submission and injects any pending messages into Claude's context. Just type anything and Claude sees the bridge messages automatically.

## Development

```bash
npm install
npm test                   # all tests (64 tests: unit + integration via wrangler dev)
npx tsc --noEmit           # type-check Node code
npx tsc --noEmit -p tsconfig.worker.json  # type-check Worker code
npx wrangler dev           # run Worker locally on :8787
npx wrangler deploy        # deploy to Cloudflare
```

Project layout:

```
src/
  shared/     # crypto.ts, protocol.ts — pure logic, no I/O
  worker/     # CF Worker + BridgeRoom Durable Object
  mcp/        # MCP server, WebSocket client, tool handlers, inbox writer
  hooks/      # UserPromptSubmit hook script
  integration/ # end-to-end tests against wrangler dev
  cli.ts      # commander-based CLI
bin/
  mcp-server.sh  # wrapper script (cd to project dir before running tsx)
```

## Security

- E2E encryption via X25519 Diffie-Hellman + XSalsa20-Poly1305
- Random 24-byte nonce prepended to ciphertext
- Relay is zero-knowledge: Durable Object sees only encrypted blobs
- Max message size 256 KB before encryption

**Known limitations (MVP):**

- No MITM protection on key exchange (relay operator could substitute keys). Self-hosted use only until out-of-band verification is added.
- No message deduplication on chat (tasks naturally dedupe via Map key)
- No 24h TTL on queued DO messages (only count-based 1000-entry cap)

## License

MIT
