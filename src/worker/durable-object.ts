import { DurableObject } from 'cloudflare:workers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  ROOM: DurableObjectNamespace;
}

interface SocketAttachment {
  role?: 'host' | 'peer';
  joinedAt: number;
}

interface MessageLogEntry {
  id: string;
  data: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LOG = 1000;

// ---------------------------------------------------------------------------
// BridgeRoom Durable Object — Hibernation API
// ---------------------------------------------------------------------------

export class BridgeRoom extends DurableObject<Env> {
  /**
   * Handle incoming HTTP requests (WebSocket upgrade).
   */
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket using the Hibernation API
    this.ctx.acceptWebSocket(server);

    // Set initial attachment
    const attachment: SocketAttachment = { joinedAt: Date.now() };
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle incoming WebSocket messages.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'Binary messages not supported' }));
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const type = parsed.type;

    switch (type) {
      case 'join':
        await this.handleJoin(ws, parsed);
        break;
      case 'relay':
        await this.handleRelay(ws, parsed);
        break;
      case 'sync':
        await this.handleSync(ws, parsed);
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
        break;
    }
  }

  /**
   * Handle WebSocket close — notify remaining peers.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const notification = JSON.stringify({ type: 'peer_disconnected' });

    for (const socket of sockets) {
      if (socket !== ws) {
        try {
          socket.send(notification);
        } catch {
          // Socket may already be closed
        }
      }
    }
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // Log for observability — no action needed beyond closing
    console.error('WebSocket error:', error);
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  private async handleJoin(ws: WebSocket, parsed: Record<string, unknown>): Promise<void> {
    const role = parsed.role;
    if (role !== 'host' && role !== 'peer') {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid role, must be "host" or "peer"' }));
      return;
    }

    // Update attachment with role
    const attachment: SocketAttachment = ws.deserializeAttachment() ?? { joinedAt: Date.now() };
    attachment.role = role;
    ws.serializeAttachment(attachment);

    // Broadcast peer_joined to all other sockets
    const notification = JSON.stringify({ type: 'peer_joined', role });
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      if (socket !== ws) {
        try {
          socket.send(notification);
        } catch {
          // Socket may already be closed
        }
      }
    }
  }

  private async handleRelay(ws: WebSocket, parsed: Record<string, unknown>): Promise<void> {
    const fullMessage = JSON.stringify(parsed);

    // Broadcast to all other connected WebSockets
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      if (socket !== ws) {
        try {
          socket.send(fullMessage);
        } catch {
          // Socket may already be closed
        }
      }
    }

    // Store in message log for sync replay
    const entry: MessageLogEntry = {
      id: generateId(),
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
  }

  private async handleSync(ws: WebSocket, parsed: Record<string, unknown>): Promise<void> {
    const lastSeenId = parsed.lastSeenId;
    if (typeof lastSeenId !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing lastSeenId' }));
      return;
    }

    const messageLog = (await this.ctx.storage.get<MessageLogEntry[]>('messageLog')) ?? [];

    // Find the index of the last seen message
    const index = messageLog.findIndex((entry) => entry.id === lastSeenId);

    // If not found, send all messages; otherwise send everything after the found index
    const toReplay = index === -1 ? messageLog : messageLog.slice(index + 1);

    for (const entry of toReplay) {
      try {
        ws.send(entry.data);
      } catch {
        // Socket may have closed
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random ID using crypto.getRandomValues (available in CF Workers).
 */
function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
