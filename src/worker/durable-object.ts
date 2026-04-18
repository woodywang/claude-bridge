import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemberInfo {
  fingerprint: string;
  publicKey: string;  // base64
  name?: string;      // optional display name
  joinedAt: number;
  online: boolean;
}

interface SocketAttachment {
  fingerprint?: string;
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
    // HTTP GET /members — return member list as JSON
    const url = new URL(request.url);
    if (url.pathname === '/members' && request.method === 'GET') {
      const members = (await this.ctx.storage.get<MemberInfo[]>('members')) ?? [];
      return new Response(JSON.stringify({ members }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

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
   *
   * Clients register via { type: 'register', fingerprint, publicKey }.
   * The DO stores the member registry and distributes public keys.
   * Encrypted data still travels as relay messages — opaque to the DO.
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
      case 'register':
        await this.handleRegister(ws, parsed);
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
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Read fingerprint from socket attachment
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    const fp = attachment?.fingerprint;

    if (fp) {
      // Mark member offline in storage (don't delete — offline members still have valid public keys)
      const members = (await this.ctx.storage.get<MemberInfo[]>('members')) ?? [];
      const member = members.find((m) => m.fingerprint === fp);
      if (member) {
        member.online = false;
        await this.ctx.storage.put('members', members);
      }

      // Broadcast member_left to remaining sockets
      const notification = JSON.stringify({ type: 'member_left', fingerprint: fp });
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

  private async handleRegister(ws: WebSocket, parsed: Record<string, unknown>): Promise<void> {
    const fp = parsed.fingerprint;
    const publicKey = parsed.publicKey;
    if (typeof fp !== 'string' || typeof publicKey !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'register requires fingerprint and publicKey' }));
      return;
    }
    const name = typeof parsed.name === 'string' ? parsed.name : undefined;

    // Store/update in members registry
    let members = (await this.ctx.storage.get<MemberInfo[]>('members')) ?? [];
    const existing = members.find((m) => m.fingerprint === fp);
    const memberInfo: MemberInfo = existing
      ? { ...existing, publicKey, name: name ?? existing.name, online: true }
      : { fingerprint: fp, publicKey, name, joinedAt: Date.now(), online: true };

    if (existing) {
      members = members.map((m) => (m.fingerprint === fp ? memberInfo : m));
    } else {
      members.push(memberInfo);
    }

    await this.ctx.storage.put('members', members);

    // Store fingerprint in socket attachment so we know who disconnects
    const attachment: SocketAttachment = ws.deserializeAttachment() ?? { joinedAt: Date.now() };
    attachment.fingerprint = fp;
    ws.serializeAttachment(attachment);

    // Send the FULL member list back to the registering client
    ws.send(JSON.stringify({ type: 'members', members }));

    // Broadcast member_joined to all OTHER sockets
    const notification = JSON.stringify({ type: 'member_joined', member: memberInfo });
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

    // Broadcast to all other connected WebSockets with seqId so clients can track
    const envelope = JSON.stringify({ ...parsed, seqId: entry.id });
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
        const replayData = JSON.parse(entry.data);
        replayData.seqId = entry.id;
        ws.send(JSON.stringify(replayData));
      } catch {
        // Socket may have closed or data may be corrupt
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
