# Design Review P0 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 3 P0 correctness issues from the design review: server-side monotonic seqId, keypair persistence, and split bridge_read/mark_read.

**Architecture:** (1) DO generates a monotonic counter instead of random hex for seqId; clients use seqId for ordering, dedup, gap detection, and context conflict resolution. (2) Keypair is saved to `~/.claude-bridge/identity.json` and reloaded on restart; fingerprint stays stable across restarts. (3) `bridge_read` no longer marks messages as read; a new `bridge_mark_read` tool handles that explicitly.

**Tech Stack:** TypeScript, Cloudflare Workers (Durable Objects), libsodium, MCP SDK, Vitest

**Spec:** `docs/superpowers/specs/2026-04-18-design-review.md`

---

## File Map

| File | Change | Purpose |
|------|--------|---------|
| `src/worker/durable-object.ts` | Modify | Monotonic seqCounter in handleRelay, numeric seqId in handleSync |
| `src/mcp/websocket.ts` | Modify | Track `_lastSeenSeqId` as `number`, send numeric in sync |
| `src/mcp/index.ts` | Modify | Parse numeric seqId from relay, pass to handleDecryptedMessage, attach to InboxMessage/LocalTask; load/save keypair; context LWW uses seqId |
| `src/mcp/tools.ts` | Modify | Add `seqId` to InboxMessage/LocalTask, sort inbox by seqId, add `bridge_mark_read` tool, remove read side-effect from `bridge_read` |
| `src/shared/crypto.ts` | Modify | Add `saveKeypair`/`loadKeypair` functions |
| `src/mcp/inbox.ts` | Modify | Add `seqId` to InboxEntry |
| `src/shared/crypto.test.ts` | Modify | Tests for keypair save/load |
| `src/shared/protocol.test.ts` | No change | Existing tests still pass |
| `src/mcp/inbox.test.ts` | No change | Existing tests still pass |

---

### Task 1: Monotonic seqId in Durable Object

**Files:**
- Modify: `src/worker/durable-object.ts:198-257`

- [ ] **Step 1: Change handleRelay to use monotonic counter**

Replace the `handleRelay` method body. The `id` field in `MessageLogEntry` becomes a number. The counter is stored as `seqCounter` in DO storage.

```typescript
private async handleRelay(ws: WebSocket, parsed: Record<string, unknown>): Promise<void> {
    const fullMessage = JSON.stringify(parsed);

    // Increment monotonic counter
    const prev = (await this.ctx.storage.get<number>('seqCounter')) ?? 0;
    const seqId = prev + 1;
    await this.ctx.storage.put('seqCounter', seqId);

    // Store in message log for sync replay
    const entry: MessageLogEntry = {
      id: String(seqId),
      data: fullMessage,
      timestamp: Date.now(),
    };

    let messageLog = (await this.ctx.storage.get<MessageLogEntry[]>('messageLog')) ?? [];
    messageLog.push(entry);

    // Evict oldest if over limit
    if (messageLog.length > MAX_MESSAGE_LOG) {
      messageLog = messageLog.slice(messageLog.length - MAX_MESSAGE_LOG);
    }

    await this.ctx.storage.put('messageLog', messageLog);

    // Broadcast to all other connected WebSockets with seqId
    const envelope = JSON.stringify({ ...parsed, seqId });
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      if (socket !== ws) {
        try {
          socket.send(envelope);
        } catch {
          // Socket may already be closed
        }
      }
    }
  }
```

- [ ] **Step 2: Update handleSync to accept numeric lastSeenId**

The client will send `lastSeenId` as a number (or string for backward compat). The lookup compares against `entry.id` which is now `String(seqId)`.

```typescript
private async handleSync(ws: WebSocket, parsed: Record<string, unknown>): Promise<void> {
    const lastSeenId = parsed.lastSeenId;
    if (lastSeenId === undefined || lastSeenId === null) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing lastSeenId' }));
      return;
    }
    const lastSeenStr = String(lastSeenId);

    const messageLog = (await this.ctx.storage.get<MessageLogEntry[]>('messageLog')) ?? [];

    // Find the index of the last seen message
    const index = messageLog.findIndex((entry) => entry.id === lastSeenStr);

    // If not found, send all messages; otherwise send everything after the found index
    const toReplay = index === -1 ? messageLog : messageLog.slice(index + 1);

    for (const entry of toReplay) {
      try {
        const replayData = JSON.parse(entry.data);
        replayData.seqId = Number(entry.id);
        ws.send(JSON.stringify(replayData));
      } catch {
        break;
      }
    }
  }
```

- [ ] **Step 3: Remove the generateId function**

Delete the `generateId()` function at the bottom of the file (it's no longer used).

- [ ] **Step 4: Type-check worker code**

Run: `npx tsc --noEmit -p tsconfig.worker.json`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/worker/durable-object.ts
git commit -m "feat: monotonic seqId counter in DO relay"
```

---

### Task 2: Client-side seqId tracking

**Files:**
- Modify: `src/mcp/websocket.ts:13,41-47,69-71,153-155`
- Modify: `src/mcp/tools.ts:18-28,30-38,46-59` (interfaces)
- Modify: `src/mcp/index.ts:185-325,394-422` (relay handler, context handler)
- Modify: `src/mcp/inbox.ts:12-18`

- [ ] **Step 1: Update websocket.ts to track numeric seqId**

Change `_lastSeenSeqId` from `string | null` to `number | null`. Update the tracking in `onMessage` and the sync message in `onOpen`.

In `websocket.ts`, change the field declaration (line 13):
```typescript
private _lastSeenSeqId: number | null = null;
```

In the `onOpen` handler, change the sync message (lines 41-47):
```typescript
        if (this._lastSeenSeqId !== null) {
          const syncMsg = JSON.stringify({
            type: 'sync',
            lastSeenId: this._lastSeenSeqId,
          });
          this.ws!.send(syncMsg);
          console.error(`[bridge-ws] Sent sync with lastSeenId=${this._lastSeenSeqId}`);
        }
```

In the `onMessage` handler, parse seqId as number (lines 69-71):
```typescript
        if (parsed && typeof parsed === 'object' && 'seqId' in parsed) {
          const raw = (parsed as Record<string, unknown>).seqId;
          this._lastSeenSeqId = typeof raw === 'number' ? raw : Number(raw);
        }
```

Change the getter return type (lines 153-155):
```typescript
  get lastSeenSeqId(): number | null {
    return this._lastSeenSeqId;
  }
```

- [ ] **Step 2: Add seqId to InboxMessage and LocalTask interfaces**

In `src/mcp/tools.ts`, add `seqId?: number` to both interfaces:

```typescript
export interface LocalTask {
  id: string;
  seqId?: number;
  description: string;
  context: string;
  priority: 'low' | 'normal' | 'high';
  status: 'pending' | 'ack' | 'in_progress' | 'done' | 'failed';
  result?: string;
  createdAt: number;
  updatedAt: number;
  direction: 'sent' | 'received';
}

export interface InboxMessage {
  id: string;
  seqId?: number;
  title: string;
  body: string;
  from: string;
  timestamp: number;
  read: boolean;
  replyTo?: string;
}
```

Add `seqId?: number` to `BridgeState.context` value type:

```typescript
context: Map<string, { value: string; timestamp: number; seqId?: number }>;
```

- [ ] **Step 3: Add seqId to InboxEntry**

In `src/mcp/inbox.ts`, add `seqId?: number` to the interface:

```typescript
export interface InboxEntry {
  id: string;
  type: string;
  from: string;
  fromName?: string;
  seqId?: number;
  timestamp: number;
  summary: string;
}
```

- [ ] **Step 4: Extract seqId from relay messages and pass through decryption**

In `src/mcp/index.ts`, the `handleRelayMessage` function needs to extract the numeric seqId from the relay envelope and pass it to `handleEncryptedMessage`, which passes it to `handleDecryptedMessage`.

Change `handleRelayMessage` — extract seqId before dispatching:
```typescript
function handleRelayMessage(data: unknown, state: BridgeState): void {
  if (!data || typeof data !== 'object') {
    console.error('[bridge] Received non-object relay message');
    return;
  }
  const msg = data as Record<string, unknown>;
  const seqId = typeof msg.seqId === 'number' ? msg.seqId : undefined;

  // DO control messages (no payload wrapper)
  if (msg.type === 'members') {
    handleMembers(msg, state);
    return;
  }
  if (msg.type === 'member_joined') {
    handleMemberJoined(msg, state);
    return;
  }
  if (msg.type === 'member_left') {
    console.error(`[bridge] Peer left: ${msg.fingerprint}`);
    return;
  }

  // Relay messages (with payload wrapper)
  const payload = msg.payload as Record<string, unknown> | undefined;
  if (!payload) {
    console.error(`[bridge] Non-payload message: ${JSON.stringify(msg)}`);
    return;
  }

  if (payload.dataType === 'encrypted') {
    handleEncryptedMessage(payload, state, seqId);
    return;
  }

  console.error(`[bridge] Unknown payload type: ${JSON.stringify(payload)}`);
}
```

Add `seqId` parameter to `handleEncryptedMessage` signature and pass to `handleDecryptedMessage`:

Change the function signature:
```typescript
function handleEncryptedMessage(
  payload: Record<string, unknown>,
  state: BridgeState,
  seqId?: number,
): void {
```

And both calls to `handleDecryptedMessage` inside it become:
```typescript
handleDecryptedMessage(message, state, seqId);
```

Change `handleDecryptedMessage` signature:
```typescript
function handleDecryptedMessage(message: BridgeMessage, state: BridgeState, seqId?: number): void {
```

- [ ] **Step 5: Attach seqId to stored messages, tasks, and context entries**

In `handleDecryptedMessage`, attach seqId to each stored object:

In the `task` case, add `seqId` to `localTask`:
```typescript
const localTask: LocalTask = {
  id: message.id,
  seqId,
  description: taskPayload.description,
  // ... rest unchanged
};
```

And to the inbox entry:
```typescript
const inboxEntry: InboxEntry = {
  id: message.id,
  type: 'task',
  from: message.from,
  fromName: senderName,
  seqId,
  timestamp: message.timestamp,
  summary: `[${taskPayload.priority}] ${taskPayload.description}`,
};
```

Apply the same pattern for `result` and `chat` inbox entries (add `seqId,` field).

In the `chat` case, add `seqId` to the `InboxMessage`:
```typescript
const inboxMsg: InboxMessage = {
  id: message.id,
  seqId,
  title: chatPayload.title,
  // ... rest unchanged
};
```

- [ ] **Step 6: Use seqId for context last-write-wins**

In the `context` case of `handleDecryptedMessage`, replace timestamp comparison with seqId:

```typescript
    case 'context': {
      const ctxPayload = message.payload as ContextPayload;
      const existingEntry = state.context.get(ctxPayload.key);

      // Last-write-wins by server-assigned seqId (falls back to timestamp for legacy messages)
      const existingSeq = existingEntry?.seqId ?? 0;
      const incomingSeq = seqId ?? 0;
      if (!existingEntry || incomingSeq >= existingSeq) {
        switch (ctxPayload.operation) {
          case 'set':
            state.context.set(ctxPayload.key, {
              value: ctxPayload.value,
              timestamp: message.timestamp,
              seqId,
            });
            break;
          case 'append': {
            const prev = existingEntry?.value ?? '';
            state.context.set(ctxPayload.key, {
              value: prev + ctxPayload.value,
              timestamp: message.timestamp,
              seqId,
            });
            break;
          }
          case 'delete':
            state.context.delete(ctxPayload.key);
            break;
        }
      }

      console.error(
        `[bridge] Context ${ctxPayload.operation}: key=${ctxPayload.key}`,
      );
      break;
    }
```

- [ ] **Step 7: Add gap detection logging**

In `src/mcp/index.ts`, add a module-level variable and gap check in `handleRelayMessage` right after extracting seqId:

```typescript
let lastProcessedSeqId = 0;
```

Inside `handleRelayMessage`, after `const seqId = ...`:
```typescript
  if (seqId !== undefined) {
    if (lastProcessedSeqId > 0 && seqId > lastProcessedSeqId + 1) {
      console.error(`[bridge] WARNING: message gap detected — expected seqId ${lastProcessedSeqId + 1}, got ${seqId}. ${seqId - lastProcessedSeqId - 1} message(s) may be lost.`);
    }
    if (seqId > lastProcessedSeqId) {
      lastProcessedSeqId = seqId;
    }
  }
```

- [ ] **Step 8: Sort inbox by seqId**

In `src/mcp/tools.ts`, update `bridge_inbox` handler to sort by `seqId` (falling back to timestamp):

```typescript
const messages = [...state.inbox.values()].sort((a, b) => {
  if (a.seqId !== undefined && b.seqId !== undefined) return b.seqId - a.seqId;
  return b.timestamp - a.timestamp;
});
```

- [ ] **Step 9: Type-check and run tests**

Run: `npx tsc --noEmit && npx vitest run --exclude 'src/integration/**'`
Expected: all 60 tests pass, no type errors

- [ ] **Step 10: Commit**

```bash
git add src/mcp/websocket.ts src/mcp/tools.ts src/mcp/index.ts src/mcp/inbox.ts
git commit -m "feat: client-side seqId tracking for ordering, dedup, and context LWW"
```

---

### Task 3: Keypair persistence

**Files:**
- Modify: `src/shared/crypto.ts`
- Modify: `src/shared/crypto.test.ts`
- Modify: `src/mcp/index.ts:78-83`

- [ ] **Step 1: Write failing tests for keypair save/load**

Add to `src/shared/crypto.test.ts`:

```typescript
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('keypair persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves and loads keypair, preserving fingerprint', async () => {
    await initCrypto();
    const kp = generateKeypair();
    const fp = fingerprint(kp.publicKey);
    const filePath = join(tempDir, 'identity.json');

    saveKeypair(kp, filePath);
    const loaded = loadKeypair(filePath);

    expect(loaded).not.toBeNull();
    expect(fingerprint(loaded!.publicKey)).toBe(fp);
    expect(Buffer.from(loaded!.privateKey)).toEqual(Buffer.from(kp.privateKey));
  });

  it('returns null when file does not exist', () => {
    const loaded = loadKeypair(join(tempDir, 'nonexistent.json'));
    expect(loaded).toBeNull();
  });

  it('returns null when file is corrupt', async () => {
    await initCrypto();
    const filePath = join(tempDir, 'identity.json');
    const { writeFileSync } = await import('fs');
    writeFileSync(filePath, 'not-json');
    const loaded = loadKeypair(filePath);
    expect(loaded).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/crypto.test.ts`
Expected: FAIL — `saveKeypair` and `loadKeypair` not exported

- [ ] **Step 3: Implement saveKeypair and loadKeypair**

Add to `src/shared/crypto.ts` at the end of the file:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Save a keypair to a JSON file. Creates parent directories if needed.
 */
export function saveKeypair(kp: Keypair, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const data = {
    publicKey: Buffer.from(kp.publicKey).toString('base64'),
    privateKey: Buffer.from(kp.privateKey).toString('base64'),
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Load a keypair from a JSON file. Returns null if file doesn't exist or is invalid.
 */
export function loadKeypair(filePath: string): Keypair | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as { publicKey: string; privateKey: string };
    return {
      publicKey: new Uint8Array(Buffer.from(data.publicKey, 'base64')),
      privateKey: new Uint8Array(Buffer.from(data.privateKey, 'base64')),
    };
  } catch {
    return null;
  }
}
```

Note: `fs` and `path` imports must use the `createRequire` pattern that already exists at the top of the file. Actually, `fs` and `path` are Node built-ins and work fine with direct imports in ESM. But this file already uses `createRequire` for libsodium specifically. Add the fs/path imports as normal ESM imports at the top:

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/crypto.test.ts`
Expected: all tests PASS (existing 13 + 3 new = 16)

- [ ] **Step 5: Use persistent keypair in MCP server**

In `src/mcp/index.ts`, replace the keypair generation section (around line 78-83):

```typescript
import { loadKeypair, saveKeypair } from '../shared/crypto.js';
import { join } from 'path';
import { homedir } from 'os';
```

Replace the keypair generation block:
```typescript
  // -----------------------------------------------------------------------
  // 4. Load or generate keypair
  // -----------------------------------------------------------------------
  const identityPath = join(homedir(), '.claude-bridge', 'identity.json');
  let keypair = loadKeypair(identityPath);
  if (keypair) {
    console.error(`[bridge] Loaded existing keypair from ${identityPath}`);
  } else {
    keypair = generateKeypair();
    saveKeypair(keypair, identityPath);
    console.error(`[bridge] Generated new keypair, saved to ${identityPath}`);
  }
  const myFingerprint = fingerprint(keypair.publicKey);
  console.error(`[bridge] Fingerprint: ${myFingerprint}`);
```

- [ ] **Step 6: Update imports in index.ts**

Add `loadKeypair`, `saveKeypair` to the existing import from `'../shared/crypto.js'`:

```typescript
import {
  initCrypto,
  generateKeypair,
  computeSharedSecret,
  decrypt,
  fingerprint,
  loadKeypair,
  saveKeypair,
} from '../shared/crypto.js';
```

Add `join` and `homedir` imports (if not already present):
```typescript
import { join } from 'path';
import { homedir } from 'os';
```

- [ ] **Step 7: Type-check and run all tests**

Run: `npx tsc --noEmit && npx vitest run --exclude 'src/integration/**'`
Expected: all tests pass (63 total now), no type errors

- [ ] **Step 8: Commit**

```bash
git add src/shared/crypto.ts src/shared/crypto.test.ts src/mcp/index.ts
git commit -m "feat: persist keypair to ~/.claude-bridge/identity.json"
```

---

### Task 4: Split bridge_read / bridge_mark_read

**Files:**
- Modify: `src/mcp/tools.ts:313-345` (bridge_read handler, add bridge_mark_read)

- [ ] **Step 1: Remove read side-effect from bridge_read**

In `src/mcp/tools.ts`, update the `bridge_read` tool handler. Remove the line `message.read = true;` and the `state.syncCounts();` call. Update the tool description.

```typescript
  server.tool(
    'bridge_read',
    'Read a specific message by its full or partial (8-char) ID. Does NOT mark as read — call bridge_mark_read after the human has reviewed.',
    {
      id: z.string().describe('Full or partial (first 8 chars) message ID'),
    },
    async ({ id }) => {
      const message = findMessageById(state, id);
      if (!message) {
        return errorResult(`Message not found: ${id}`);
      }

      const date = new Date(message.timestamp);
      const dateStr = date.toISOString().replace('T', ' ').substring(0, 16);

      const sender = peerDisplayName(state, message.from);
      const parts = [
        `From: ${sender}`,
        `Date: ${dateStr}`,
        `Title: ${message.title}`,
        '',
        message.body,
        '',
        '---',
        `Mark as read: bridge_mark_read ${message.id.substring(0, 8)}`,
        `Reply: bridge_draft_reply ${message.id.substring(0, 8)} <draft>`,
      ];

      return textResult(parts.join('\n'));
    },
  );
```

- [ ] **Step 2: Add bridge_mark_read tool**

Add immediately after the `bridge_read` tool registration:

```typescript
  server.tool(
    'bridge_mark_read',
    'Mark one or more messages as read. Call this after the human has reviewed the message content.',
    {
      ids: z.array(z.string()).describe('Full or partial message IDs to mark as read'),
    },
    async ({ ids }) => {
      const marked: string[] = [];
      const notFound: string[] = [];

      for (const id of ids) {
        const message = findMessageById(state, id);
        if (message) {
          message.read = true;
          marked.push(message.id.substring(0, 8));
        } else {
          notFound.push(id);
        }
      }

      state.syncCounts();

      if (notFound.length > 0) {
        return textResult(`Marked ${marked.length} as read. Not found: ${notFound.join(', ')}`);
      }
      return textResult(`Marked ${marked.length} as read: ${marked.join(', ')}`);
    },
  );
```

- [ ] **Step 3: Update hook instructions**

In `src/hooks/check-inbox.ts`, update the workflow instructions to mention `bridge_mark_read`:

```typescript
console.log('处理流程:');
console.log('1. 使用 Agent 工具派遣子代理(subagent)读取消息: 子代理调用 bridge_read 读取完整内容，');
console.log('   然后调用 bridge_draft_reply 为每条需要回复的消息起草回复，将草稿返回给主代理。');
console.log('2. 主代理将草稿展示给人类用户，由用户确认或修改回复内容，以及是否抄送(CC)给其他 peer。');
console.log('3. 用户确认后，主代理调用 bridge_reply 发送最终回复，调用 bridge_mark_read 标记已读。');
console.log('重要: 绝不能跳过人类确认步骤直接发送回复。\n');
```

- [ ] **Step 4: Type-check and run all tests**

Run: `npx tsc --noEmit && npx vitest run --exclude 'src/integration/**'`
Expected: all tests pass, no type errors

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/hooks/check-inbox.ts
git commit -m "feat: split bridge_read/bridge_mark_read, remove read side-effect"
```

---

### Task 5: Update docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update CLAUDE.md tool list**

In the MCP Tools section of `CLAUDE.md`, update the messaging tools to reflect the new tool:

```markdown
**Messaging:**
- `bridge_send(title, body)` — broadcast to all peers
- `bridge_inbox()` — list messages with read/unread, sender names (sorted by server seqId)
- `bridge_read(id)` — read full message (does NOT mark as read)
- `bridge_mark_read(ids)` — mark messages as read after human review
- `bridge_draft_reply(id, draft_body, suggested_cc?)` — draft reply for human review (does NOT send)
- `bridge_reply(id, body, cc?, cc_context?)` — send confirmed reply; targeted to sender, optional CC
```

Add a note about seqId in the Architecture section:

```markdown
- **Server-side ordering**: DO assigns a monotonic `seqId` to each relayed message. Clients use seqId for inbox sorting, context conflict resolution (last-write-wins), gap detection, and dedup. Client timestamps are for display only.
```

Add a note about identity persistence:

```markdown
- **Persistent identity**: Keypair saved to `~/.claude-bridge/identity.json`. Fingerprint survives process restarts.
```

- [ ] **Step 2: Update README.md tool table and workflow**

Update the Messaging table to include `bridge_mark_read`. Update the Reply Workflow step 5 to mention `bridge_mark_read`.

In the Security section, add:
```markdown
- Persistent identity: keypair saved to `~/.claude-bridge/identity.json` (mode 0600), stable across restarts
- Server-assigned monotonic seqId for message ordering (no client clock dependency)
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update for seqId, keypair persistence, bridge_mark_read"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.worker.json`
Expected: no errors for both

- [ ] **Step 2: Full test suite**

Run: `npx vitest run --exclude 'src/integration/**'`
Expected: all tests pass (63 total: 38 protocol + 16 crypto + 9 inbox)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean build, no errors
