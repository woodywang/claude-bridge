interface Env {
  ROOM: DurableObjectNamespace;
}

// ── Worker (fetch handler) ────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // remove empty segments

    // GET /room/create → generate a random 6-char room code
    if (request.method === "GET" && parts[0] === "room" && parts[1] === "create") {
      const code = generateCode();
      return Response.json({ code });
    }

    // GET /room/:code/ws → upgrade to WebSocket via the Room DO
    if (
      request.method === "GET" &&
      parts[0] === "room" &&
      parts[1] !== undefined &&
      parts[2] === "ws"
    ) {
      const code = parts[1];
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      // Forward the request to the DO; use an internal URL to route to /ws
      return stub.fetch(new Request("http://internal/ws", request));
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ── Room Durable Object ───────────────────────────────────────────────────────

interface SocketAttachment {
  role?: "host" | "peer";
}

export class Room {
  private ctx: DurableObjectState;
  // env is stored for potential future use (e.g. KV, secrets)
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // Upgrade to WebSocket using the Hibernation API
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      // Hibernation API: ctx.acceptWebSocket, not server.accept()
      this.ctx.acceptWebSocket(server);

      // Initialise attachment so deserializeAttachment never returns null
      server.serializeAttachment({} as SocketAttachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not Found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      ws.send(JSON.stringify({ type: "error", message: "message must be a JSON object" }));
      return;
    }

    const msg = parsed as Record<string, unknown>;

    switch (msg.type) {
      case "join": {
        const role = msg.role as "host" | "peer";
        if (role !== "host" && role !== "peer") {
          ws.send(JSON.stringify({ type: "error", message: 'role must be "host" or "peer"' }));
          return;
        }
        // Persist role on this socket so it survives hibernation
        ws.serializeAttachment({ role } satisfies SocketAttachment);
        // Notify all other sockets that a peer joined
        this.broadcast(ws, JSON.stringify({ type: "peer_joined", role }));
        break;
      }

      case "relay": {
        // Forward the entire message (opaque encrypted blob) to all other sockets
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        this.broadcast(ws, raw);
        break;
      }

      default: {
        ws.send(JSON.stringify({ type: "error", message: "unknown type" }));
        break;
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    // Ensure the socket is closed on our side too
    ws.close(code, reason);
    // Notify remaining peers
    this.broadcast(ws, JSON.stringify({ type: "peer_disconnected" }));
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("[Room] WebSocket error:", error);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Send a message to all WebSockets in this room EXCEPT the sender. */
  private broadcast(sender: WebSocket, message: string): void {
    for (const client of this.ctx.getWebSockets()) {
      if (client !== sender) {
        try {
          client.send(message);
        } catch (err) {
          console.error("[Room] Failed to send to client:", err);
        }
      }
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Generate a random 6-character alphanumeric room code (uppercase). */
function generateCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  // crypto.getRandomValues is available in the Workers runtime
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    code += chars[byte % chars.length];
  }
  return code;
}
