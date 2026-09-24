import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

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
