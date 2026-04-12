# claude-bridge

E2E encrypted cross-machine Claude Code collaboration tool.

## Project Overview

Two Claude Code instances on different machines communicate through a Cloudflare Workers relay. All messages are E2E encrypted (libsodium). The relay sees only opaque blobs.

## Architecture

- **Cloudflare Worker + Durable Object (Hibernation API)**: WebSocket relay, zero-knowledge
- **MCP Server (single process)**: stdio transport for Claude Code + WebSocket to CF DO
- **Protocol**: Control plane (unencrypted: sync, key exchange) + Data plane (encrypted: messages)
- **Encryption**: libsodium-wrappers (X25519 + XSalsa20-Poly1305, random nonce prepended)

## Tech Stack

- TypeScript, ESM (`moduleResolution: NodeNext`)
- Cloudflare Workers + Durable Objects (Wrangler)
- libsodium-wrappers (encryption)
- @modelcontextprotocol/sdk (MCP server, StdioServerTransport)
- Vitest (testing)
- commander (CLI)

## Key Constraints

- Never use `console.log()` in MCP server code (corrupts stdio JSON-RPC). Use `console.error()` only.
- All messages pass through encrypt/decrypt path, even in dev.
- Max message size: 256KB before encryption.
- No task auto-timeouts. Tasks are explicitly cancelled.
- 1:1 rooms only (no multi-party for MVP).

## Design Docs

- `docs/design.md` — Original design document from /office-hours
- `docs/implementation-plan.md` — Implementation plan from /plan-eng-review
- `docs/test-plan.md` — Test plan with coverage targets

## Testing

```bash
npx vitest run
```
