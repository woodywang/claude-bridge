# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

E2E encrypted multi-party Claude Code collaboration. N Claude Code instances on different machines communicate through a Cloudflare Workers relay. All messages are pairwise-encrypted with libsodium. The relay sees only opaque blobs.

## Architecture

```
Claude A ←stdio→ MCP Server ←WSS→ CF Durable Object (relay) ←WSS→ MCP Server ←stdio→ Claude B
                 (encrypt)         (member registry,          (decrypt)
                                    message log, zero-knowledge)
```

- **DO maintains member registry**: fingerprint, publicKey, name, online status. New member gets full member list on connect; existing members get `member_joined` push.
- **MCP Server (single process)**: stdio for Claude Code + WebSocket to DO. Computes pairwise shared secrets from member public keys on connect.
- **Multi-recipient encryption**: each message encrypted separately per peer (pairwise X25519 DH + XSalsa20-Poly1305). Wire format: `{from: fingerprint, recipients: {fp: blob, ...}}`.
- **Two tsconfigs**: `tsconfig.json` for Node code (NodeNext), `tsconfig.worker.json` for CF Worker (bundler).

## Commands

```bash
npm test                                    # unit tests (60 tests)
npx vitest run --exclude 'src/integration/**'  # unit only (skip wrangler)
npx vitest run src/shared/crypto.test.ts    # single test file
npx tsc --noEmit                            # type-check Node code
npx tsc --noEmit -p tsconfig.worker.json    # type-check Worker code
npx wrangler dev                            # local Worker on :8787
npx wrangler deploy                         # deploy to Cloudflare
```

## Key Constraints

- **NEVER `console.log()` in `src/mcp/`** — corrupts stdio JSON-RPC. Use `console.error()` only. The hook script (`src/hooks/`) and CLI (`src/cli.ts`) MAY use `console.log`.
- **ESM with `.js` extensions** — all imports must use `.js` suffix (`import { foo } from './bar.js'`).
- **libsodium CJS workaround** — `libsodium-wrappers` ESM is broken on Node 25. Must use `createRequire` to load CJS bundle (see `src/shared/crypto.ts`).
- **Max message size**: 256KB before encryption.
- **Worker env is NOT Node.js** — `src/worker/` runs on CF Workers runtime. No `fs`, `path`, `node:` imports.

## Module Boundaries

| Directory | Runtime | I/O | Notes |
|-----------|---------|-----|-------|
| `src/shared/` | Any | None | Pure logic: crypto, protocol types, serialize/deserialize |
| `src/worker/` | CF Workers | DO storage, WebSocket | Separate tsconfig. No Node imports |
| `src/mcp/` | Node.js | stdio, WebSocket, filesystem | MCP server + tools. Never console.log |
| `src/hooks/` | Node.js | filesystem, stdout | Standalone script, MAY console.log |
| `src/cli.ts` | Node.js | filesystem, network, stdout | MAY console.log |

## Data Flow

1. Claude calls MCP tool (e.g. `bridge_send`) → `tools.ts`
2. `encryptAndSend` serializes message, encrypts per-peer → WebSocket relay envelope
3. DO broadcasts to other sockets → peer MCP servers receive
4. Peer decrypts with sender's pairwise secret → `handleDecryptedMessage` dispatches by type
5. Chat → `state.inbox` Map + `counts.json` + hook inbox file
6. Task → `state.tasks` Map + hook inbox file

## Identity

Each instance identified by **pubkey fingerprint** (BLAKE2b first 4 bytes → 8 hex chars). Used as `from` field in messages and as key in `recipients` map. DO stores fingerprint → publicKey mapping in member registry.

## Design Docs

- `docs/design.md` — original design document
- `docs/implementation-plan.md` — implementation plan with spike findings
- `docs/test-plan.md` — test coverage targets
