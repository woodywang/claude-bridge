import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  encrypt,
  type Keypair,
} from '../shared/crypto.js';
import {
  type BridgeMessage,
  type ChatPayload,
  createBridgeMessage,
  serializeMessage,
} from '../shared/protocol.js';
import type { BridgeWebSocket } from './websocket.js';

export interface BridgeState {
  role: 'host' | 'peer';
  roomCode: string;
  ws: BridgeWebSocket;
  keypair: Keypair;
  sharedSecret: Uint8Array | null;
  inbox: BridgeMessage[];
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
    'Get pending messages received from the peer',
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
}
