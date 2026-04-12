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
}

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

export function registerTools(server: McpServer, state: BridgeState): void {
  // bridge_status — returns current bridge connection status
  server.tool(
    'bridge_status',
    'Returns the current status of the bridge connection',
    {},
    async () => {
      const status = {
        role: state.role,
        roomCode: state.roomCode,
        wsConnected: state.ws.connected,
        keyExchangeDone: state.sharedSecret !== null,
        pendingMessages: state.inbox.length,
      };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
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
      if (!state.sharedSecret) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Key exchange not complete yet. Wait for the peer to connect and exchange keys before sending messages.',
            },
          ],
          isError: true,
        };
      }

      if (!state.ws.connected) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: WebSocket is not connected. Waiting for reconnection.',
            },
          ],
          isError: true,
        };
      }

      try {
        // Create and serialize the BridgeMessage
        const msg = createBridgeMessage('chat', state.role, {
          content,
        } satisfies ChatPayload);
        const serialized = serializeMessage(msg);

        // Encrypt
        const encrypted = encrypt(serialized, state.sharedSecret);
        const blob = Buffer.from(encrypted).toString('base64');

        // Wrap in relay envelope and send
        const envelope = JSON.stringify({
          type: 'relay',
          payload: {
            dataType: 'encrypted',
            blob,
          },
        });
        state.ws.send(envelope);

        return {
          content: [
            {
              type: 'text' as const,
              text: `Message sent (${serialized.byteLength} bytes plaintext, ${blob.length} bytes encrypted+base64, id=${msg.id})`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error sending message: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // bridge_get_messages — retrieve pending messages from inbox
  server.tool(
    'bridge_get_messages',
    'Get pending incoming messages from the peer. Messages are removed from the inbox once returned (consume-once).',
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
          // If not found, return all messages (the since ID may have been cleared already)
          messages = state.inbox.splice(0, maxMessages);
        } else {
          // Remove everything up to and including the `since` message, then take up to limit
          state.inbox.splice(0, idx + 1);
          messages = state.inbox.splice(0, maxMessages);
        }
      } else {
        messages = state.inbox.splice(0, maxMessages);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                count: messages.length,
                remaining: state.inbox.length,
                messages,
              },
              null,
              2,
            ),
          },
        ],
      };
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
      if (!state.sharedSecret) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Key exchange not complete yet.',
            },
          ],
          isError: true,
        };
      }

      if (!state.ws.connected) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: WebSocket is not connected.',
            },
          ],
          isError: true,
        };
      }

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

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  taskId: msg.id,
                  note: '任务已发送，请到对方机器的 Claude 会话里输入任意内容触发接收',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error sending task: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                count: tasks.length,
                tasks,
              },
              null,
              2,
            ),
          },
        ],
      };
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
      const task = state.tasks.get(id);
      if (!task) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Task not found: ${id}`,
            },
          ],
          isError: true,
        };
      }

      if (!state.sharedSecret) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Key exchange not complete yet.',
            },
          ],
          isError: true,
        };
      }

      if (!state.ws.connected) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: WebSocket is not connected.',
            },
          ],
          isError: true,
        };
      }

      try {
        // Update local task
        task.status = status;
        if (result !== undefined) {
          task.result = result;
        }
        task.updatedAt = Date.now();

        // Send result to peer
        const msg = createBridgeMessage('result', state.role, {
          taskId: id,
          status,
          summary: result,
        } satisfies ResultPayload);

        encryptAndSend(msg, state);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  taskId: id,
                  status,
                  updated: true,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error updating task: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
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
      const task = state.tasks.get(id);
      if (!task) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Task not found: ${id}`,
            },
          ],
          isError: true,
        };
      }

      if (!state.sharedSecret) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Key exchange not complete yet.',
            },
          ],
          isError: true,
        };
      }

      if (!state.ws.connected) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: WebSocket is not connected.',
            },
          ],
          isError: true,
        };
      }

      try {
        // Mark local task as failed
        task.status = 'failed';
        task.result = reason ?? 'Cancelled';
        task.updatedAt = Date.now();

        // Send result to peer
        const msg = createBridgeMessage('result', state.role, {
          taskId: id,
          status: 'failed',
          summary: reason ?? 'Cancelled',
        } satisfies ResultPayload);

        encryptAndSend(msg, state);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  taskId: id,
                  status: 'failed',
                  reason: reason ?? 'Cancelled',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error cancelling task: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // bridge_get_context — return the shared context KV store
  server.tool(
    'bridge_get_context',
    'Get the entire shared context key-value store',
    {},
    async () => {
      const contextObj: Record<string, { value: string; timestamp: number }> =
        {};
      for (const [key, val] of state.context.entries()) {
        contextObj[key] = val;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(contextObj, null, 2),
          },
        ],
      };
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
      if (!state.sharedSecret) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Key exchange not complete yet.',
            },
          ],
          isError: true,
        };
      }

      if (!state.ws.connected) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: WebSocket is not connected.',
            },
          ],
          isError: true,
        };
      }

      try {
        const timestamp = Date.now();

        // Update local context
        state.context.set(key, { value, timestamp });

        // Send context update to peer
        const msg = createBridgeMessage('context', state.role, {
          key,
          value,
          operation: 'set',
        } satisfies ContextPayload);

        encryptAndSend(msg, state);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  key,
                  value,
                  timestamp,
                  synced: true,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error setting context: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
