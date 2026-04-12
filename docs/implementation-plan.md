# Plan: claude-bridge Implementation

## Context
claude-bridge is an E2E encrypted cross-machine Claude Code collaboration tool. Two Claude Code instances on different machines communicate through a Cloudflare Workers relay, with all messages encrypted end-to-end so the relay sees only opaque blobs.

Primary use case: full-stack dev with backend on remote server (k8s access, no GUI) and frontend on local machine (GUI browser). During integration testing, server Claude Code sends tasks/context to local Claude Code.

Design doc: `~/.gstack/projects/claude-bridge/woody-unknown-design-20260412-142135.md`

## Architecture (post-review)

```
┌──────────────────────┐        ┌──────────────────────┐        ┌──────────────────────┐
│   Remote Server      │        │   Cloudflare Edge    │        │   Local Machine      │
│                      │        │                      │        │                      │
│  Claude Code         │        │  Worker              │        │  Claude Code          │
│    ↕ stdio           │        │    ↕                 │        │    ↕ stdio            │
│  MCP Server ←──WSS──→│───────→│  Durable Object     │←───────│←──WSS── MCP Server    │
│  (bridge process)    │        │  (Hibernation API)   │        │  (bridge process)     │
│  libsodium encrypt   │        │  sees only blobs     │        │  libsodium decrypt    │
└──────────────────────┘        └──────────────────────┘        └──────────────────────┘
```

**Key findings from feasibility spikes (2026-04-12):**
1. **libsodium-wrappers ESM broken on Node 25** — bare `import` fails (missing companion `.mjs` file in package). Fix: use `createRequire(import.meta.url)` to load CJS bundle. Must apply in `src/shared/crypto.ts`.
2. **Key exchange timing** — when both sides connect simultaneously, each broadcasts pubkey but may miss the other's. Fix: upon receiving peer's pubkey, re-broadcast own pubkey so peer can complete exchange.
3. **MCP stdio + WebSocket coexistence** — validated. Single Node.js process can hold `StdioServerTransport` + long-lived WebSocket without conflict.

**Key decisions from eng review:**
1. **Single process MCP server** (no daemon) — MCP server holds WebSocket connection directly. Lives/dies with Claude Code. Messages queue in DO when offline.
2. **libsodium-wrappers** over tweetnacl — audited, Signal/WhatsApp-grade, same NaCl API
3. **WebSocket Hibernation API** — DO sleeps when idle, no billable duration. Cost < $0.50/month
4. **Two-layer protocol** — control plane (unencrypted: sync, key exchange, room mgmt) + data plane (encrypted: BridgeMessage payloads)
5. **Random nonce** prepended to ciphertext for XSalsa20-Poly1305
6. **No task timeouts** — tasks are explicitly cancelled, not auto-timed-out (Claude Code runs can take 30+ min)
7. **Explicit MCP registration** — `claude-bridge mcp-install` command, not npm postinstall

## Module Structure

```
src/
  shared/
    protocol.ts      # BridgeMessage types, serialize/deserialize, control messages
    crypto.ts         # libsodium: keypair gen, DH, encrypt/decrypt, nonce mgmt
  mcp/
    index.ts          # MCP server entry, stdio transport, WebSocket connection
    tools.ts          # bridge_* MCP tool handlers
    websocket.ts      # WebSocket connection mgmt, reconnect, sync replay
    inbox.ts          # Write incoming messages to ~/.claude-bridge/inbox.json for hook pickup
  worker/
    index.ts          # CF Worker entry, routes to DO
    durable-object.ts # DO class: Hibernation WebSocket, room lifecycle, message relay
  hooks/
    check-inbox.ts    # UserPromptSubmit hook script: read inbox.json, output to stdout if non-empty
  cli.ts              # CLI: host, join, status, mcp-install (also installs hook)
package.json
tsconfig.json
wrangler.toml
vitest.config.ts
```

10 source files. Clean boundaries: `shared/` is pure logic (no IO), `mcp/` handles Claude Code + network, `worker/` is CF-side, `hooks/` is Claude Code hook integration.

## Protocol

### Control Plane (unencrypted, DO can read)
```typescript
type ControlMessage =
  | { type: 'sync'; lastSeenId: string }           // replay missed messages
  | { type: 'key_exchange'; publicKey: string }     // X25519 public key
  | { type: 'room_status'; status: 'ready' | 'paired' | 'closed' }
```

### Data Plane (encrypted, DO sees blobs only)
```typescript
type BridgeMessage = {
  id: string;              // UUID
  protocolVersion: 1;
  type: 'task' | 'context' | 'result' | 'chat';
  from: string;            // public key fingerprint
  timestamp: number;
  payload: TaskPayload | ContextPayload | ResultPayload | ChatPayload;
};

// Wire format: nonce (24 bytes) + ciphertext
// Max message size: 256KB before encryption
```

### MCP Tools
- `bridge_send_message(content)` — send encrypted chat message
- `bridge_send_task(description, context, priority)` — dispatch task
- `bridge_get_messages(since?, limit=50)` — read messages (limit param for perf)
- `bridge_get_tasks(status?)` — list tasks
- `bridge_update_task(id, status, result?)` — update task (no auto-timeout)
- `bridge_cancel_task(id, reason?)` — explicit cancellation
- `bridge_get_context()` — read shared context KV store
- `bridge_set_context(key, value)` — write to shared context (last-write-wins)

## Build Sequence

### Phase 1: CF Relay + Encryption (Day 1-2)
- `wrangler.toml` + Worker entry point
- Durable Object with Hibernation WebSocket API (`serializeAttachment`/`deserializeAttachment` for per-connection state)
- Room create/join with 6-char room codes
- Control plane: key exchange, room status
- `src/shared/crypto.ts`: libsodium keypair, DH, encrypt/decrypt with random nonce
- Data plane: encrypted message relay (DO stores blobs, replays on sync)

### Phase 2: MCP Server (Day 2-3)
- MCP server with `@modelcontextprotocol/sdk` + `StdioServerTransport`
- **CRITICAL**: Never `console.log()` — use `console.error()` only (stdio corruption)
- **CRITICAL**: ESM with `moduleResolution: NodeNext` in tsconfig
- WebSocket connection to CF DO within MCP process
- bridge_send_message + bridge_get_messages working end-to-end

### Phase 3: Tasks + Context + Hook Notification (Day 3-4)
- Task dispatch and result flow
- Client-side task state tracking (in-memory)
- Context KV store (set/get/append/delete, last-write-wins)
- Explicit task cancellation (no timeouts)
- **Incoming message notification via Claude Code hook:**
  - MCP server writes incoming messages to `~/.claude-bridge/inbox.json` on WebSocket receive
  - `UserPromptSubmit` hook script reads inbox file; if non-empty, outputs message summary to stdout → injected into Claude Code prompt
  - `claude-bridge mcp-install` also installs the hook into `.claude/settings.json`
  - Sending side: `bridge_send_task` / `bridge_send_message` tool response includes "任务已发送，请到对方机器的 Claude 会话里输入任意内容触发接收"
- **Flow:** Server Claude sends task → MCP server encrypts → CF relay → Local MCP server decrypts → writes to inbox.json → User types anything in local Claude → Hook fires, injects message → Local Claude sees and handles task

### Phase 4: CLI + Polish (Day 4-5)
- `claude-bridge host` — create room, display code
- `claude-bridge join <code>` — join existing room
- `claude-bridge status` — show connection status
- `claude-bridge mcp-install` — register MCP server in Claude Code settings AND install `UserPromptSubmit` hook
- Reconnection with sync replay from DO
- Graceful error handling

### Phase 5: Tests + Validation (Day 5-7)
- Unit tests (Vitest): crypto round-trip, protocol serialization, task state
- Integration tests: two MCP instances via `wrangler dev`
- Manual E2E: two machines, task dispatch, encrypted communication
- Security smoke: verify all traffic is encrypted via proxy intercept

## Testing Strategy
- **Framework**: Vitest
- **Unit**: crypto (9 test cases), protocol (5 test cases), tasks (5 test cases), inbox (2 test cases: write/read/clear cycle, hook script stdout format)
- **Integration**: two bridge instances via wrangler dev, room pairing, message relay
- **Manual E2E checklist**: two machines, full flow
- Test plan: `~/.gstack/projects/claude-bridge/woody-main-eng-review-test-plan-20260412-144500.md`

## Failure Modes
| Failure | Handling | Test? |
|---------|----------|-------|
| WebSocket disconnect | Reconnect + sync replay (DO replays by lastSeenId) | Integration |
| Peer offline | Messages queue in DO (24h TTL) | Integration |
| Wrong room code | DO rejects with error | Unit |
| Wrong decryption key | libsodium throws, message discarded with warning | Unit |
| DO eviction | State persisted in DO storage, WebSocket re-established | Integration |
| Claude Code exits | MCP server dies, WebSocket closes, DO queues future messages | By design |
| Message too large | Rejected before encryption (256KB limit) | Unit |

## NOT in Scope
- Daemon / background process (not needed — user confirmed)
- Task auto-timeout (replaced with explicit cancellation)
- Multi-session (1:1 only)
- Public service auth/billing/rate-limiting
- File transfer
- Session replay
- CI/CD pipeline for npm publishing
- Watcher process / `claude --print` spawning (replaced with hook-based notification)
- tmux / OS-level input injection (not cross-machine compatible)

## Worktree Parallelization Strategy

| Step | Modules touched | Depends on |
|------|----------------|------------|
| Phase 1: CF Relay | worker/ + shared/ | — |
| Phase 2: MCP Server | mcp/ + shared/ | Phase 1 (needs relay endpoint) |
| Phase 3: Tasks + Context | mcp/ + shared/ | Phase 2 |
| Phase 4: CLI | cli.ts | Phase 1 (needs room create/join API) |
| Phase 5: Tests | test/ | Phase 1-3 |

**Parallel lanes:**
- Lane A: Phase 1 (relay) → Phase 2 (MCP) → Phase 3 (tasks) — sequential, shared modules
- Lane B: Phase 4 (CLI) — can start after Phase 1, independent from mcp/

Launch A first. Start B after Phase 1 merges. Then Phase 5.

## Verification
1. `wrangler dev` — run CF Worker locally
2. Two terminal windows, each running `claude-bridge host` / `claude-bridge join <code>`
3. Send a message from one → verify receipt on other
4. Verify via `wrangler tail` that DO logs show only encrypted blobs
5. `vitest run` — all unit + integration tests pass
6. In Claude Code: `bridge_send_task("test task", "test context", "normal")` → verify other side receives
7. Hook verification: send task from side A → switch to side B's Claude Code → type anything → verify bridge message is injected into prompt and Claude responds to it

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 6 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE VOICE:** Claude subagent challenged daemon necessity and task timeouts. Both accepted — daemon removed, timeouts replaced with explicit cancellation.
- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — ready to implement

## Sources
- [CF DO WebSocket Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [CF DO Hibernation Example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [libsodium-wrappers npm](https://www.npmjs.com/package/libsodium-wrappers)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
