import { wsEnvelopeSchema, type WsEnvelope } from '@videochat/shared';

/** Base URL for the realtime endpoint (no query string). Same-origin proxying (see api.ts)
 *  doesn't apply here: the socket never needs the refresh cookie -- it authenticates with the
 *  access token as a query parameter -- so it's simplest to connect straight to the API's own
 *  origin, cross-site or not. VITE_REALTIME_URL is the ws(s):// counterpart of VITE_API_URL. */
export const REALTIME_URL =
  (import.meta.env.VITE_REALTIME_URL as string | undefined) ?? '/realtime';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** Exponential backoff with full jitter on the lower half, capped at `MAX_DELAY_MS`: attempt 0
 *  is close to immediate, and repeated failures fan out instead of every client retrying in
 *  lockstep against a recovering server. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(cap / 2 + random() * (cap / 2));
}

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

export interface RealtimeClientOptions {
  /** Supplies the current access token; called fresh on every (re)connect attempt so a token
   *  refreshed in the meantime is picked up automatically. */
  getAccessToken: () => string | null;
  onEvent?: (envelope: WsEnvelope) => void;
  onStatusChange?: (status: RealtimeStatus) => void;
  url?: string;
  /** Overridable for tests. */
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
}

/**
 * CHAT-013: the realtime client. Reconnects automatically with exponential backoff and jitter
 * after any drop that wasn't requested by calling `disconnect()`, and never fans out more than
 * one open socket to the server.
 */
export class RealtimeClient {
  private readonly url: string;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly random: () => number;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private disconnected = false;

  constructor(private readonly options: RealtimeClientOptions) {
    this.url = options.url ?? REALTIME_URL;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.random = options.random ?? Math.random;
  }

  connect(): void {
    this.disconnected = false;
    this.open();
  }

  /** Closes the socket and stops reconnecting. Call this on logout. */
  disconnect(): void {
    this.disconnected = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private open(): void {
    const token = this.options.getAccessToken();
    if (!token) {
      // No session yet (e.g. not logged in): try again shortly rather than giving up, since
      // this client is typically constructed once and connected from app startup.
      this.scheduleReconnect();
      return;
    }

    this.options.onStatusChange?.('connecting');
    const separator = this.url.includes('?') ? '&' : '?';
    const socket = new this.WebSocketImpl(
      `${this.url}${separator}token=${encodeURIComponent(token)}`,
    );
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.options.onStatusChange?.('open');
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const parsed = wsEnvelopeSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) this.options.onEvent?.(parsed.data as WsEnvelope);
    });

    socket.addEventListener('close', () => {
      this.options.onStatusChange?.('closed');
      if (this.socket === socket) this.socket = null;
      if (!this.disconnected) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delay = reconnectDelayMs(this.attempt, this.random);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.disconnected) this.open();
    }, delay);
  }
}
