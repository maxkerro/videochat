import { wsEnvelopeSchema, type WsEnvelope } from '@videochat/shared';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** Exponential backoff with jitter, capped: the first retry is near-immediate and repeated
 *  failures spread out instead of every phone hammering a recovering server in lockstep. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(cap / 2 + random() * (cap / 2));
}

export type RealtimeStatus = 'closed' | 'connecting' | 'open';

/** The small part of the WebSocket API this client uses (React Native's WebSocket has it). */
export interface SocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

const OPEN = 1;

export interface RealtimeClientOptions {
  url: string;
  /** A valid access token, refreshed if it is about to expire; null when signed out. */
  getAccessToken: () => Promise<string | null>;
  onEvent: (envelope: WsEnvelope) => void;
  onStatus: (status: RealtimeStatus) => void;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
}

/**
 * CHAT-054: the app's WebSocket connection. `connect()` / `close()` express what the app wants
 * (the lifecycle controller decides when); while connecting is wanted, any drop is retried with
 * backoff, and there is never more than one socket. Sockets are tagged so a late event from a
 * socket that was already replaced or closed is ignored.
 */
export class RealtimeClient {
  private socket: SocketLike | null = null;
  private wanted = false;
  private opening = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private status: RealtimeStatus = 'closed';

  constructor(private readonly options: RealtimeClientOptions) {}

  connect(): void {
    this.wanted = true;
    if (this.socket || this.opening || this.timer !== undefined) return;
    void this.open();
  }

  /** Stops reconnecting and closes the socket. */
  close(): void {
    this.wanted = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
    this.setStatus('closed');
  }

  /** Best effort: a no-op unless the socket is open (typing and viewing signals are ephemeral). */
  send(envelope: WsEnvelope): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(envelope));
    return true;
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  private setStatus(next: RealtimeStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.options.onStatus(next);
  }

  private async open(): Promise<void> {
    this.opening = true;
    this.setStatus('connecting');
    const token = await this.options.getAccessToken().catch(() => null);
    this.opening = false;
    // Closed (or replaced) while the token was being fetched.
    if (!this.wanted || this.socket) return;
    if (!token) {
      this.scheduleReconnect();
      return;
    }
    const separator = this.options.url.includes('?') ? '&' : '?';
    const url = `${this.options.url}${separator}token=${encodeURIComponent(token)}`;
    const socket = (this.options.createSocket ?? ((u) => new WebSocket(u) as SocketLike))(url);
    this.socket = socket;

    // "Open" means the server confirmed it registered this socket (`realtime.ready`), not just that
    // the handshake finished: until then an event could still slip past. A server that accepts and
    // immediately rejects the token never gets there, so the retry backoff keeps growing.
    socket.onopen = null;
    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = wsEnvelopeSchema.safeParse(json);
      if (!parsed.success) return;
      if (parsed.data.type === 'realtime.ready') {
        this.attempt = 0;
        this.setStatus('open');
      }
      this.options.onEvent(parsed.data as WsEnvelope);
    };
    socket.onerror = () => {
      // A `close` always follows; the retry is scheduled there.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus('closed');
      if (this.wanted) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setStatus('closed');
    const delay = reconnectDelayMs(this.attempt, this.options.random);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.wanted && !this.socket) void this.open();
    }, delay);
  }
}
