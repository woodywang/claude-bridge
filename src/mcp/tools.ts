import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  encrypt,
  type Keypair,
} from '../shared/crypto.js';
import {
  type BridgeMessage,
  type ChatPayload,
  type TaskPayload,
  type ResultPayload,
  type ContextPayload,
  createBridgeMessage,
  serializeMessage,
} from '../shared/protocol.js';
import type { BridgeWebSocket } from './websocket.js';

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
  direction: 'sent' | 'received'; // did we send or receive this task?
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

export interface PeerInfo {
  fingerprint: string;
  name?: string;
  publicKey: Uint8Array;
  sharedSecret: Uint8Array;
}

export interface BridgeState {
  role: 'host' | 'peer';
  roomCode: string;
  myName: string;               // user-configured alias
  ws: BridgeWebSocket;
  keypair: Keypair;
  myFingerprint: string;       // own pubkey fingerprint
  peers: Map<string, PeerInfo>; // keyed by fingerprint
  inbox: Map<string, InboxMessage>;
  tasks: Map<string, LocalTask>;
  context: Map<string, { value: string; timestamp: number; seqId?: number }>;
  syncCounts: () => void;
}

// ---------------------------------------------------------------------------
// MCP result helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function requireConnected(state: BridgeState): ReturnType<typeof errorResult> | null {
  if (state.peers.size === 0) {
    return errorResult('No peers connected. Wait for someone to join the room.');
  }
  if (!state.ws.connected) {
    return errorResult('WebSocket not connected. Check bridge status.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Encrypt + send helper
// ---------------------------------------------------------------------------

/**
 * Encrypt a BridgeMessage and send via WebSocket relay.
 * If targetFingerprints is provided, sends only to those peers (targeted reply/CC).
 * Otherwise broadcasts to all peers.
 */
function encryptAndSend(
  msg: BridgeMessage,
  state: BridgeState,
  targetFingerprints?: string[],
): { plaintextBytes: number; recipientCount: number } {
  const serialized = serializeMessage(msg);
  const targets = targetFingerprints ?? [...state.peers.keys()];

  const recipients: Record<string, string> = {};
  for (const fp of targets) {
    const peer = state.peers.get(fp);
    if (!peer) continue;
    const encrypted = encrypt(serialized, peer.sharedSecret);
    recipients[fp] = Buffer.from(encrypted).toString('base64');
  }

  if (Object.keys(recipients).length === 0) {
    throw new Error('No valid recipients found');
  }

  const envelope = JSON.stringify({
    type: 'relay',
    payload: {
      dataType: 'encrypted',
      from: state.myFingerprint,
      recipients,
    },
  });
  state.ws.send(envelope);

  return { plaintextBytes: serialized.byteLength, recipientCount: Object.keys(recipients).length };
}

// ---------------------------------------------------------------------------
// Shared task update helper (used by bridge_update_task and bridge_cancel_task)
// ---------------------------------------------------------------------------

async function updateTaskAndNotify(
  state: BridgeState,
  taskId: string,
  status: ResultPayload['status'],
  summary?: string,
  details?: string,
): Promise<ReturnType<typeof textResult>> {
  const task = state.tasks.get(taskId);
  if (!task) return errorResult(`Task not found: ${taskId}`);

  const err = requireConnected(state);
  if (err) return err;

  task.status = status;
  if (summary) task.result = summary;
  task.updatedAt = Date.now();

  const msg = createBridgeMessage('result', state.myFingerprint, {
    taskId,
    status,
    summary,
    details,
  } as ResultPayload);

  encryptAndSend(msg, state);
  state.syncCounts();
  return textResult(`Task ${taskId} updated to ${status}`);
}

// ---------------------------------------------------------------------------
// Helper: relative time formatting
// ---------------------------------------------------------------------------

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ---------------------------------------------------------------------------
// Helper: find message by full or partial ID
// ---------------------------------------------------------------------------

function peerDisplayName(state: BridgeState, fingerprint: string): string {
  const peer = state.peers.get(fingerprint);
  return peer?.name ? `${peer.name} (${fingerprint})` : fingerprint;
}

function findPeerByNameOrFp(state: BridgeState, nameOrFp: string): PeerInfo | undefined {
  const byFp = state.peers.get(nameOrFp);
  if (byFp) return byFp;
  for (const peer of state.peers.values()) {
    if (peer.name && peer.name.toLowerCase() === nameOrFp.toLowerCase()) return peer;
  }
  return undefined;
}

function findMessageById(state: BridgeState, id: string): InboxMessage | undefined {
  // Try exact match first
  const exact = state.inbox.get(id);
  if (exact) return exact;

  // Try partial match (first 8 chars)
  for (const [key, msg] of state.inbox) {
    if (key.startsWith(id)) return msg;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, state: BridgeState): void {
  // bridge_status — returns current bridge connection status
  server.tool(
    'bridge_status',
    'Returns the current status of the bridge connection',
    {},
    async () => {
      const unread = [...state.inbox.values()].filter((m) => !m.read).length;
      return textResult(JSON.stringify({
        role: state.role,
        myName: state.myName,
        roomCode: state.roomCode,
        myFingerprint: state.myFingerprint,
        wsConnected: state.ws.connected,
        peers: [...state.peers.values()].map((p) => ({
          fingerprint: p.fingerprint,
          name: p.name,
        })),
        peerCount: state.peers.size,
        inboxTotal: state.inbox.size,
        inboxUnread: unread,
      }, null, 2));
    },
  );

  // bridge_members — list all members in the room
  server.tool(
    'bridge_members',
    'List all members (Claude Code instances) in the room, including self',
    {},
    async () => {
      const self = {
        fingerprint: state.myFingerprint,
        name: state.myName,
        role: state.role,
        isSelf: true,
        online: state.ws.connected,
      };
      const peers = [...state.peers.values()].map((p) => ({
        fingerprint: p.fingerprint,
        name: p.name ?? 'unknown',
        isSelf: false,
      }));
      const members = [self, ...peers];
      return textResult(JSON.stringify({ count: members.length, members }, null, 2));
    },
  );

  // bridge_send — encrypt and send a titled message
  server.tool(
    'bridge_send',
    'Send an encrypted message. Broadcasts to all peers by default, or specify recipients by name/fingerprint for private messages.',
    {
      title: z.string().describe('Message title / subject'),
      body: z.string().describe('Message body'),
      to: z
        .array(z.string())
        .optional()
        .describe('Recipient names or fingerprints. Omit to broadcast to all peers.'),
    },
    async ({ title, body, to }) => {
      const err = requireConnected(state);
      if (err) return err;

      try {
        const msg = createBridgeMessage('chat', state.myFingerprint, {
          title,
          body,
        } satisfies ChatPayload);

        let targets: string[] | undefined;
        const sentTo: string[] = [];
        const notFound: string[] = [];

        if (to && to.length > 0) {
          targets = [];
          for (const nameOrFp of to) {
            const peer = findPeerByNameOrFp(state, nameOrFp);
            if (peer) {
              targets.push(peer.fingerprint);
              sentTo.push(peerDisplayName(state, peer.fingerprint));
            } else {
              notFound.push(nameOrFp);
            }
          }
          if (targets.length === 0) {
            return errorResult(`No valid recipients found: ${notFound.join(', ')}`);
          }
        }

        encryptAndSend(msg, state, targets);

        const recipientDesc = targets
          ? sentTo.join(', ') + (notFound.length > 0 ? `. Not found: ${notFound.join(', ')}` : '')
          : 'all peers';
        return textResult(`Sent "${title}" to ${recipientDesc}`);
      } catch (e) {
        return errorResult(`Error sending message: ${(e as Error).message}`);
      }
    },
  );

  // bridge_inbox — list all messages in the inbox
  server.tool(
    'bridge_inbox',
    'List all messages in the inbox (newest first). Shows read/unread status, short ID, sender, title, and relative time.',
    {},
    async () => {
      const messages = [...state.inbox.values()].sort((a, b) => {
        if (a.seqId !== undefined && b.seqId !== undefined) return b.seqId - a.seqId;
        return b.timestamp - a.timestamp;
      });
      const unread = messages.filter((m) => !m.read).length;

      if (messages.length === 0) {
        return textResult('📬 Inbox is empty.');
      }

      const lines = messages.map((m) => {
        const readMarker = m.read ? '[ ]' : '[●]';
        const idShort = m.id.substring(0, 8);
        const timeRel = formatRelativeTime(m.timestamp);
        const sender = peerDisplayName(state, m.from);
        return `  ${readMarker} ${idShort} | ${sender} | ${m.title} | ${timeRel}`;
      });

      const header = `📬 ${messages.length} messages (${unread} unread)`;
      return textResult([header, '', ...lines].join('\n'));
    },
  );

  // bridge_read — read a specific message by ID (full or partial)
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

  // bridge_mark_read — mark one or more messages as read
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

  // bridge_draft_reply — draft a reply for human review (does NOT send)
  server.tool(
    'bridge_draft_reply',
    'Draft a reply to a message for human review. Returns the original message context, peer list for CC, and a template. Does NOT send anything — the human must review and approve before calling bridge_reply.',
    {
      id: z.string().describe('Full or partial (first 8 chars) message ID to reply to'),
      draft_body: z.string().describe('Proposed reply body for the human to review'),
      suggested_cc: z
        .array(z.string())
        .optional()
        .describe('Suggested peer names to CC (human can modify)'),
    },
    async ({ id, draft_body, suggested_cc }) => {
      const original = findMessageById(state, id);
      if (!original) {
        return errorResult(`Message not found: ${id}`);
      }

      const sender = peerDisplayName(state, original.from);
      const reTitle = original.title.startsWith('Re: ')
        ? original.title
        : `Re: ${original.title}`;

      // Build available peers list for CC selection
      const availablePeers = [...state.peers.values()]
        .filter((p) => p.fingerprint !== original.from) // exclude original sender
        .map((p) => ({ name: p.name ?? 'unknown', fingerprint: p.fingerprint }));

      return textResult(JSON.stringify({
        action: 'draft_reply',
        originalMessage: {
          id: original.id,
          from: sender,
          fromFingerprint: original.from,
          title: original.title,
          body: original.body,
          timestamp: original.timestamp,
        },
        draft: {
          title: reTitle,
          body: draft_body,
        },
        suggestedCC: suggested_cc ?? [],
        availablePeersForCC: availablePeers,
        instructions: '请将以上草稿展示给人类用户确认。用户可以修改回复内容、选择是否抄送其他 peer。确认后调用 bridge_reply 发送。',
      }, null, 2));
    },
  );

  // bridge_reply — send a confirmed reply (human must have approved)
  server.tool(
    'bridge_reply',
    'Send a confirmed reply to a message. IMPORTANT: The human user MUST have reviewed and approved the reply content before calling this tool. Optionally CC other peers with additional context.',
    {
      id: z.string().describe('Full or partial (first 8 chars) message ID to reply to'),
      body: z.string().describe('Reply body text (confirmed by the human user)'),
      cc: z
        .array(z.string())
        .optional()
        .describe('Peer names or fingerprints to CC on this reply'),
      cc_context: z
        .string()
        .optional()
        .describe('Additional context to prepend for CC recipients (e.g. background info they need)'),
    },
    async ({ id, body, cc, cc_context }) => {
      const err = requireConnected(state);
      if (err) return err;

      const original = findMessageById(state, id);
      if (!original) {
        return errorResult(`Message not found: ${id}`);
      }

      try {
        const reTitle = original.title.startsWith('Re: ')
          ? original.title
          : `Re: ${original.title}`;

        // Send reply to original sender (targeted)
        const replyMsg = createBridgeMessage('chat', state.myFingerprint, {
          title: reTitle,
          body,
          replyTo: original.id,
        } satisfies ChatPayload);

        encryptAndSend(replyMsg, state, [original.from]);
        const sentTo = [peerDisplayName(state, original.from)];

        // Send CC copies to other peers if specified
        const ccSentTo: string[] = [];
        if (cc && cc.length > 0) {
          const ccFingerprints: string[] = [];
          const notFound: string[] = [];
          for (const nameOrFp of cc) {
            const peer = findPeerByNameOrFp(state, nameOrFp);
            if (peer) {
              ccFingerprints.push(peer.fingerprint);
            } else {
              notFound.push(nameOrFp);
            }
          }

          if (ccFingerprints.length > 0) {
            const ccBody = cc_context
              ? `[CC] 上下文: ${cc_context}\n\n---\n原始消息来自 ${peerDisplayName(state, original.from)}:\n> ${original.title}\n> ${original.body}\n\n---\n回复:\n${body}`
              : `[CC] 回复 ${peerDisplayName(state, original.from)} 的消息 "${original.title}":\n\n${body}`;

            const ccMsg = createBridgeMessage('chat', state.myFingerprint, {
              title: `[CC] ${reTitle}`,
              body: ccBody,
              replyTo: original.id,
            } satisfies ChatPayload);

            encryptAndSend(ccMsg, state, ccFingerprints);

            for (const fp of ccFingerprints) {
              ccSentTo.push(peerDisplayName(state, fp));
            }
          }

          if (notFound.length > 0) {
            return textResult(
              `Reply sent to ${sentTo.join(', ')}` +
              (ccSentTo.length > 0 ? `. CC sent to ${ccSentTo.join(', ')}` : '') +
              `. CC peers not found: ${notFound.join(', ')}`,
            );
          }
        }

        // Auto mark the original message as read after successful reply
        original.read = true;
        state.syncCounts();

        const result = `Reply sent to ${sentTo.join(', ')}` +
          (ccSentTo.length > 0 ? `. CC sent to ${ccSentTo.join(', ')}` : '');
        return textResult(result);
      } catch (e) {
        return errorResult(`Error sending reply: ${(e as Error).message}`);
      }
    },
  );

  // bridge_send_task — create and send a task to the peer
  server.tool(
    'bridge_send_task',
    'Send a task to the peer through the bridge',
    {
      description: z.string().describe('Description of the task'),
      context: z.string().describe('Context or additional details for the task'),
      priority: z
        .enum(['low', 'normal', 'high'])
        .describe('Task priority'),
    },
    async ({ description, context, priority }) => {
      const err = requireConnected(state);
      if (err) return err;

      try {
        const msg = createBridgeMessage('task', state.myFingerprint, {
          description,
          context,
          priority,
        } satisfies TaskPayload);

        encryptAndSend(msg, state);

        // Store locally as sent task
        const now = Date.now();
        const localTask: LocalTask = {
          id: msg.id,
          description,
          context,
          priority,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
          direction: 'sent',
        };
        state.tasks.set(msg.id, localTask);

        return textResult(JSON.stringify({
          taskId: msg.id,
          note: '任务已发送，请到对方机器的 Claude 会话里输入任意内容触发接收',
        }, null, 2));
      } catch (e) {
        return errorResult(`Error sending task: ${(e as Error).message}`);
      }
    },
  );

  // bridge_get_tasks — retrieve tasks from local store
  server.tool(
    'bridge_get_tasks',
    'Get tasks from the local task store, optionally filtered by status',
    {
      status: z
        .enum(['pending', 'ack', 'in_progress', 'done', 'failed'])
        .optional()
        .describe('Filter tasks by status'),
    },
    async ({ status }) => {
      let tasks = Array.from(state.tasks.values());
      if (status) {
        tasks = tasks.filter((t) => t.status === status);
      }

      return textResult(JSON.stringify({ count: tasks.length, tasks }, null, 2));
    },
  );

  // bridge_update_task — update a task's status and send result to peer
  server.tool(
    'bridge_update_task',
    'Update a task status and notify the peer',
    {
      id: z.string().describe('Task ID to update'),
      status: z
        .enum(['ack', 'in_progress', 'done', 'failed'])
        .describe('New task status'),
      result: z
        .string()
        .optional()
        .describe('Result or summary of the task'),
    },
    async ({ id, status, result }) => {
      return updateTaskAndNotify(state, id, status, result);
    },
  );

  // bridge_cancel_task — cancel a task and notify peer
  server.tool(
    'bridge_cancel_task',
    'Cancel a task and notify the peer',
    {
      id: z.string().describe('Task ID to cancel'),
      reason: z
        .string()
        .optional()
        .describe('Reason for cancellation'),
    },
    async ({ id, reason }) => {
      return updateTaskAndNotify(state, id, 'failed', reason ?? 'Cancelled');
    },
  );

  // bridge_get_context — return the shared context KV store
  server.tool(
    'bridge_get_context',
    'Get the entire shared context key-value store',
    {},
    async () => {
      const contextObj: Record<string, { value: string; timestamp: number }> = {};
      for (const [key, val] of state.context.entries()) {
        contextObj[key] = val;
      }
      return textResult(JSON.stringify(contextObj, null, 2));
    },
  );

  // bridge_set_context — set a key-value pair and sync to peer
  server.tool(
    'bridge_set_context',
    'Set a key-value pair in the shared context store and sync to peer',
    {
      key: z.string().describe('Context key'),
      value: z.string().describe('Context value'),
    },
    async ({ key, value }) => {
      const err = requireConnected(state);
      if (err) return err;

      try {
        const timestamp = Date.now();
        state.context.set(key, { value, timestamp });

        const msg = createBridgeMessage('context', state.myFingerprint, {
          key,
          value,
          operation: 'set',
        } satisfies ContextPayload);

        encryptAndSend(msg, state);

        return textResult(JSON.stringify({ key, value, timestamp, synced: true }, null, 2));
      } catch (e) {
        return errorResult(`Error setting context: ${(e as Error).message}`);
      }
    },
  );
}
