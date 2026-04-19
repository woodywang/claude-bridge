# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What This Is

E2E encrypted multi-party Claude Code collaboration. N instances on different machines communicate through a Cloudflare Workers relay. All messages are pairwise-encrypted with libsodium. The relay sees only opaque blobs.

## Architecture

```
Browser → [Google OAuth] → Session → Web Admin (create room, manage tokens)
CLI     → [API Token]    → Bearer  → POST /api/room/create
                                        ↓
Claude A ←stdio→ MCP Server ←WSS→ CF Worker (auth) → DO (relay) ←WSS→ MCP Server ←stdio→ Claude B
                 (encrypt)         (join secret      (member registry,   (decrypt)
                                    validation)       message log, zero-knowledge)
```

- **Worker auth layer**: Google OAuth login, KV-backed sessions, API tokens for CLI. Room creation requires authentication. WebSocket join requires room join secret.
- **DO maintains member registry**: fingerprint, publicKey, name, online status. DO is zero-knowledge — no auth info.
- **MCP Server (single process)**: stdio for Claude Code + WebSocket to DO. Computes pairwise shared secrets on connect.
- **Pairwise encryption**: each message encrypted separately per recipient (X25519 DH + XSalsa20-Poly1305). Wire format: `{from: fingerprint, recipients: {fp: blob, ...}}`.
- **Targeted sending**: `encryptAndSend(msg, state, targets?)` sends to specific peers when targets provided, broadcasts otherwise.
- **Server-side ordering**: DO assigns a monotonic `seqId` to each relayed message. Clients use seqId for inbox sorting, context conflict resolution (last-write-wins), gap detection, and dedup. Client timestamps are for display only.
- **Persistent identity**: Keypair saved to `~/.claude-bridge/identity-<name>.json` (per alias). Fingerprint survives process restarts. Multiple instances on the same machine get distinct identities.
- **Two tsconfigs**: `tsconfig.json` for Node code (NodeNext), `tsconfig.worker.json` for CF Worker (bundler).

## Identity & Alias

Each instance has a **required alias** (`BRIDGE_NAME` env / `--name` CLI flag) and a **pubkey fingerprint** (BLAKE2b first 4 bytes → 8 hex chars). Both are stored in the DO member registry. Tools display peers as `name (fingerprint)`.

## Message Reply Workflow

Replies follow a **draft → human confirm → send** flow:

1. Sub-agent reads message via `bridge_read`, drafts reply via `bridge_draft_reply`
2. Sub-agent returns draft to main agent, which presents it to the human
3. Human confirms/edits content, chooses CC recipients
4. Main agent calls `bridge_reply(id, body, cc?, cc_context?)` to send, then `bridge_mark_read` to mark as read
5. Reply goes to original sender only (targeted); CC copies go to specified peers with context

**Never skip the human confirmation step.**

## Sub-agent Message Processing

Incoming messages trigger a `UserPromptSubmit` hook. The hook instructs Claude to dispatch message processing to a **sub-agent** (via Agent tool) to avoid polluting the main conversation context. The sub-agent reads messages and drafts replies; the main agent handles human interaction and final send.

## Commands

```bash
npm run build                               # compile TypeScript to dist/
npm test                                    # unit tests (63 tests)
npx vitest run --exclude 'src/integration/**'  # unit only (skip wrangler)
npx vitest run src/shared/crypto.test.ts    # single test file
npx tsc --noEmit                            # type-check Node code
npx tsc --noEmit -p tsconfig.worker.json    # type-check Worker code
npx wrangler dev                            # local Worker on :8787
npx wrangler deploy                         # deploy to Cloudflare
```

## Key Constraints

- **NEVER `console.log()` in `src/mcp/`** — corrupts stdio JSON-RPC. Use `console.error()` only. Hook scripts and CLI MAY use `console.log`.
- **ESM with `.js` extensions** — all imports must use `.js` suffix.
- **libsodium CJS workaround** — `libsodium-wrappers` ESM is broken on Node 25. Must use `createRequire` to load CJS bundle (see `src/shared/crypto.ts`).
- **Max message size**: 256KB before encryption.
- **Worker env is NOT Node.js** — `src/worker/` runs on CF Workers runtime. No `fs`, `path`, `node:` imports.

## Module Boundaries

| Directory | Runtime | I/O | Notes |
|-----------|---------|-----|-------|
| `src/shared/` | Any | None | Pure logic: crypto, protocol types |
| `src/worker/` | CF Workers | DO storage, WebSocket, KV | Separate tsconfig. No Node imports. Auth + API + pages modules. |
| `src/mcp/` | Node.js | stdio, WebSocket, filesystem | MCP server + tools. Never console.log |
| `src/hooks/` | Node.js | filesystem, stdout | Hook script, MAY console.log |
| `src/cli.ts` | Node.js | filesystem, network, stdout | MAY console.log |

## MCP Tools

**Room:**
- `bridge_status()` — connection info, peer list, inbox counts
- `bridge_members()` — list all instances (self + peers) with name, fingerprint, role

**Messaging:**
- `bridge_send(title, body, to?)` — send to specific peers or broadcast to all
- `bridge_inbox()` — list messages with read/unread, sender names (sorted by server seqId)
- `bridge_read(id)` — read full message (does NOT mark as read)
- `bridge_mark_read(ids)` — mark messages as read after human review
- `bridge_draft_reply(id, draft_body, suggested_cc?)` — draft reply for human review (does NOT send)
- `bridge_reply(id, body, cc?, cc_context?)` — send confirmed reply; targeted to sender, optional CC

**Tasks:**
- `bridge_send_task(description, context, priority)` — dispatch task to all peers
- `bridge_get_tasks(status?)` — list tasks
- `bridge_update_task(id, status, result?)` — update + notify peers
- `bridge_cancel_task(id, reason?)` — cancel + notify peers

**Shared state:**
- `bridge_get_context()` / `bridge_set_context(key, value)` — synced KV store

## Data Flow

1. Claude calls MCP tool → `tools.ts`
2. `encryptAndSend` (broadcast or targeted) → WebSocket relay
3. DO assigns monotonic seqId, broadcasts to recipients → peer MCP servers decrypt
4. `handleDecryptedMessage` dispatches: chat → inbox + hook file, task → tasks + hook file
5. Hook reads `~/.claude-bridge/inbox.json` on next user input → injects into prompt
6. Claude spawns sub-agent to process messages → draft → human confirm → send

## Design Docs

- `docs/design.md` — original design document
- `docs/implementation-plan.md` — implementation plan
- `docs/test-plan.md` — test coverage targets
