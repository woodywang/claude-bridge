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
  title: string;
  body: string;
  from: string;
  timestamp: number;
  read: boolean;
  replyTo?: string;
}

export interface PeerInfo {
  fingerprint: string;
  publicKey: Uint8Array;
  sharedSecret: Uint8Array;
}

export interface BridgeState {
  role: 'host' | 'peer';
  roomCode: string;
  ws: BridgeWebSocket;
  keypair: Keypair;
  myFingerprint: string;       // own pubkey fingerprint
  peers: Map<string, PeerInfo>; // keyed by fingerprint
  inbox: Map<string, InboxMessage>;
  tasks: Map<string, LocalTask>;
  context: Map<string, { value: string; timestamp: number }>;
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
 * Helper: encrypt a BridgeMessage and send via WebSocket relay.
 * Encrypts separately for each peer (pairwise encryption).
 * Returns the serialized byte length and recipient count.
 */
function encryptAndSend(
  msg: BridgeMessage,
  state: BridgeState,
): { plaintextBytes: number; recipientCount: number } {
  const serialized = serializeMessage(msg);

  // Encrypt separately for each peer
  const recipients: Record<string, string> = {};
  for (const [fp, peer] of state.peers) {
    const encrypted = encrypt(serialized, peer.sharedSecret);
    recipients[fp] = Buffer.from(encrypted).toString('base64');
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
        roomCode: state.roomCode,
        myFingerprint: state.myFingerprint,
        wsConnected: state.ws.connected,
        peers: [...state.peers.keys()],
        peerCount: state.peers.size,
        inboxTotal: state.inbox.size,
        inboxUnread: unread,
      }, null, 2));
    },
  );

  // bridge_send — encrypt and send a titled message to the peer
  server.tool(
    'bridge_send',
    'Send an encrypted message (with title and body) to the peer through the bridge',
    {
      title: z.string().describe('Message title / subject'),
      body: z.string().describe('Message body'),
    },
    async ({ title, body }) => {
      const err = requireConnected(state);
      if (err) return err;

      try {
        const msg = createBridgeMessage('chat', state.myFingerprint, {
          title,
          body,
        } satisfies ChatPayload);

        encryptAndSend(msg, state);

        return textResult(`Sent: ${title}`);
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
      const messages = [...state.inbox.values()].sort((a, b) => b.timestamp - a.timestamp);
      const unread = messages.filter((m) => !m.read).length;

      if (messages.length === 0) {
        return textResult('📬 Inbox is empty.');
      }

      const lines = messages.map((m) => {
        const readMarker = m.read ? '[ ]' : '[●]';
        const idShort = m.id.substring(0, 8);
        const timeRel = formatRelativeTime(m.timestamp);
        return `  ${readMarker} ${idShort} | ${m.from} | ${m.title} | ${timeRel}`;
      });

      const header = `📬 ${messages.length} messages (${unread} unread)`;
      return textResult([header, '', ...lines].join('\n'));
    },
  );

  // bridge_read — read a specific message by ID (full or partial)
  server.tool(
    'bridge_read',
    'Read a specific message by its full or partial (8-char) ID. Marks the message as read.',
    {
      id: z.string().describe('Full or partial (first 8 chars) message ID'),
    },
    async ({ id }) => {
      const message = findMessageById(state, id);
      if (!message) {
        return errorResult(`Message not found: ${id}`);
      }

      message.read = true;
      state.syncCounts();

      const date = new Date(message.timestamp);
      const dateStr = date.toISOString().replace('T', ' ').substring(0, 16);

      const parts = [
        `From: ${message.from}`,
        `Date: ${dateStr}`,
        `Title: ${message.title}`,
        '',
        message.body,
        '',
        '---',
        `Reply with: bridge_reply ${message.id.substring(0, 8)} <your reply body>`,
      ];

      return textResult(parts.join('\n'));
    },
  );

  // bridge_reply — reply to a specific message
  server.tool(
    'bridge_reply',
    'Reply to a message. Sends a new message with "Re: <original_title>" as title.',
    {
      id: z.string().describe('Full or partial (first 8 chars) message ID to reply to'),
      body: z.string().describe('Reply body text'),
    },
    async ({ id, body }) => {
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

        const msg = createBridgeMessage('chat', state.myFingerprint, {
          title: reTitle,
          body,
          replyTo: original.id,
        } satisfies ChatPayload);

        encryptAndSend(msg, state);

        return textResult(`Replied to "${original.title}": ${reTitle}`);
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
