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

export interface BridgeState {
  role: 'host' | 'peer';
  roomCode: string;
  ws: BridgeWebSocket;
  keypair: Keypair;
  sharedSecret: Uint8Array | null;
  inbox: BridgeMessage[];
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
  if (!state.sharedSecret) {
    return errorResult('Key exchange not complete. Wait for the peer to connect.');
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
 * Returns the serialized byte length and base64 blob length.
 */
function encryptAndSend(
  msg: BridgeMessage,
  state: BridgeState,
): { plaintextBytes: number; blobLength: number } {
  const serialized = serializeMessage(msg);
  const encrypted = encrypt(serialized, state.sharedSecret!);
  const blob = Buffer.from(encrypted).toString('base64');

  const envelope = JSON.stringify({
    type: 'relay',
    payload: {
      dataType: 'encrypted',
      blob,
    },
  });
  state.ws.send(envelope);

  return { plaintextBytes: serialized.byteLength, blobLength: blob.length };
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

  const msg = createBridgeMessage('result', state.role, {
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
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, state: BridgeState): void {
  // bridge_status — returns current bridge connection status
  server.tool(
    'bridge_status',
    'Returns the current status of the bridge connection',
    {},
    async () => {
      return textResult(JSON.stringify({
        role: state.role,
        roomCode: state.roomCode,
        wsConnected: state.ws.connected,
        keyExchangeDone: state.sharedSecret !== null,
        pendingMessages: state.inbox.length,
      }, null, 2));
    },
  );

  // bridge_send_message — encrypt and send a chat message to the peer
  server.tool(
    'bridge_send_message',
    'Send an encrypted message to the peer through the bridge',
    {
      content: z.string().describe('The message content to send'),
    },
    async ({ content }) => {
      const err = requireConnected(state);
      if (err) return err;

      try {
        const msg = createBridgeMessage('chat', state.role, {
          content,
        } satisfies ChatPayload);

        const { plaintextBytes, blobLength } = encryptAndSend(msg, state);

        return textResult(
          `Message sent (${plaintextBytes} bytes plaintext, ${blobLength} bytes encrypted+base64, id=${msg.id})`,
        );
      } catch (e) {
        return errorResult(`Error sending message: ${(e as Error).message}`);
      }
    },
  );

  // bridge_get_messages — retrieve pending messages from inbox
  server.tool(
    'bridge_get_messages',
    'Get pending incoming chat messages from the peer. Messages are removed from the inbox once returned (consume-once). For tasks, use bridge_get_tasks instead.',
    {
      since: z
        .string()
        .optional()
        .describe('Only return messages after this message ID'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of messages to return (default 50)'),
    },
    async ({ since, limit }) => {
      const maxMessages = limit ?? 50;

      let messages: BridgeMessage[];
      if (since) {
        const idx = state.inbox.findIndex((m) => m.id === since);
        if (idx === -1) {
          messages = state.inbox.splice(0, maxMessages);
        } else {
          state.inbox.splice(0, idx + 1);
          messages = state.inbox.splice(0, maxMessages);
        }
      } else {
        messages = state.inbox.splice(0, maxMessages);
      }

      state.syncCounts();
      return textResult(JSON.stringify({
        count: messages.length,
        remaining: state.inbox.length,
        messages,
      }, null, 2));
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
        const msg = createBridgeMessage('task', state.role, {
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

        const msg = createBridgeMessage('context', state.role, {
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
