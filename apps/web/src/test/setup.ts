import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
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
// an inert stub that never actually connects. A plain assignment (not vi.stubGlobal) so it
// survives any test file's own `vi.unstubAllGlobals()` in its afterEach.
class NoopWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = NoopWebSocket.CONNECTING;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = NoopWebSocket.CLOSED;
  }
  send() {}
}
window.WebSocket = NoopWebSocket as unknown as typeof WebSocket;
