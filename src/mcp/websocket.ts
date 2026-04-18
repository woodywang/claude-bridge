import WebSocket from 'ws';

const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

export class BridgeWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: (data: unknown) => void;
  private reconnectDelay = MIN_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private _lastSeenSeqId: number | null = null;
  private onOpen?: () => void;

  constructor(
    url: string,
    onMessage: (data: unknown) => void,
    onOpen?: () => void,
  ) {
    this.url = url;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        console.error(`[bridge-ws] Connected to ${this.url}`);
        this.reconnectDelay = MIN_RECONNECT_DELAY;

        // If reconnecting and we have a last seen seqId, send sync
        if (this._lastSeenSeqId !== null) {
          const syncMsg = JSON.stringify({
            type: 'sync',
            lastSeenId: this._lastSeenSeqId,
          });
          this.ws!.send(syncMsg);
          console.error(`[bridge-ws] Sent sync with lastSeenId=${this._lastSeenSeqId}`);
        }

        this.onOpen?.();

        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        const str = typeof data === 'string' ? data : data.toString();
        let parsed: unknown;
        try {
          parsed = JSON.parse(str);
        } catch {
          // Not JSON — pass through as raw string
          this.onMessage(str);
          return;
        }
        // Track seqId from relay messages
        if (parsed && typeof parsed === 'object' && 'seqId' in parsed) {
          const raw = (parsed as Record<string, unknown>).seqId;
          this._lastSeenSeqId = typeof raw === 'number' ? raw : Number(raw);
        }
        this.onMessage(parsed);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.error(
          `[bridge-ws] Disconnected (code=${code}, reason=${reason.toString()})`,
        );
        this.ws = null;

        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket closed before open: code=${code}`));
          return;
        }

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err: Error) => {
        console.error(`[bridge-ws] Error: ${err.message}`);
        // The close event will fire after this, triggering reconnect
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    console.error(
      `[bridge-ws] Reconnecting in ${this.reconnectDelay}ms...`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        console.error(
          `[bridge-ws] Reconnect failed: ${(err as Error).message}`,
        );
        // Exponential backoff
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          MAX_RECONNECT_DELAY,
        );
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      }
    }, this.reconnectDelay);
  }

  send(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(data);
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get lastSeenSeqId(): number | null {
    return this._lastSeenSeqId;
  }
}
