import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// CHAT-017: the offline outbox (src/lib/outbox.ts) is backed by real IndexedDB, which jsdom
// doesn't implement at all -- without this, every outbox call would throw
// `ReferenceError: indexedDB is not defined`. `fake-indexeddb/auto` installs a spec-compliant
// in-memory implementation as the global, so outbox tests exercise real IndexedDB semantics
// (transactions, key paths, `getAll`) rather than a hand-rolled mock.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  // Fresh IndexedDB per test -- fake-indexeddb otherwise keeps every database (and everything
  // written to it, e.g. the offline outbox) alive for the whole worker's lifetime, leaking state
  // from one test's outbox into the next.
  globalThis.indexedDB = new IDBFactory();
});

// CHAT-016: ChatPane's message list is virtualized with @tanstack/react-virtual, which sizes
// itself off the scroll container's real layout (via ResizeObserver and getBoundingClientRect)
// -- neither of which jsdom implements (it does no layout at all; every element reports a 0x0
// rect and there's no ResizeObserver global). Without these, the virtualizer would think its
// viewport is 0px tall and render no rows, breaking every test that looks for message text. A
// fixed non-zero rect is a reasonable stand-in: no test in this suite asserts on real pixel
// positions, only on which messages are present.
if (!window.ResizeObserver) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
// @tanstack/react-virtual reads the scroll element's size via `offsetWidth`/`offsetHeight`
// (not getBoundingClientRect), which jsdom always reports as 0 since it does no real layout.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });

// jsdom has no matchMedia; default to the light OS theme.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// CHAT-013: every screen is wrapped in <RealtimeProvider>, which opens a WebSocket connection as
// soon as a test authenticates (e.g. by mocking `POST /auth/refresh`). jsdom's WebSocket can't
// resolve the app's relative /realtime URL and there's no server to talk to anyway, so tests get
// a stub instead. It never talks to a real server (`send` is a no-op and it never delivers a
// `message` event on its own -- a test that needs one dispatches it manually), but CHAT-017's
// `ConnectionStatus` banner and reconnect-driven gap sync/outbox flush both depend on actually
// observing `open`/`close`, so unlike the fully inert stub this replaced, it implements real
// listener registration and opens itself on the next microtask -- close to how an instant local
// connection behaves, without a real handshake. A plain assignment (not vi.stubGlobal) so it
// survives any test file's own `vi.unstubAllGlobals()` in its afterEach; a test that needs to
// control connectivity itself (never opening, or closing on demand) stubs `WebSocket` locally.
class NoopWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = NoopWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<(event: { type: string }) => void>>();

  constructor(public url: string) {
    queueMicrotask(() => {
      if (this.readyState !== NoopWebSocket.CONNECTING) return; // Closed before it had a chance to open.
      this.readyState = NoopWebSocket.OPEN;
      this.dispatch('open');
    });
  }

  addEventListener(type: string, listener: (event: { type: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: { type: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    if (this.readyState === NoopWebSocket.CLOSED) return;
    this.readyState = NoopWebSocket.CLOSED;
    this.dispatch('close');
  }

  send(): void {}

  private dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
}
window.WebSocket = NoopWebSocket as unknown as typeof WebSocket;
