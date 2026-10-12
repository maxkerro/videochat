import { describe, expect, it, vi } from 'vitest';
import type { ApiFetch, ApiResponseLike } from '@videochat/shared';
import { NotSignedInError, createSessionManager } from './session';
import type { TokenStorage } from './storage';

const USER = {
  id: '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c',
  username: 'max',
  displayName: 'Max',
  email: 'max@example.com',
  emailVerified: true,
  avatarUrl: null,
};

function sessionBody(n: number, ttlMs = 15 * 60_000, now = 1_000_000) {
  return {
    accessToken: `access-${n}`,
    accessTokenExpiresAt: new Date(now + ttlMs).toISOString(),
    user: USER,
    refreshToken: `refresh-${n}`,
  };
}

function res(status: number, body: unknown = {}): ApiResponseLike {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(text),
    clone: () => ({ json: () => Promise.resolve(body) }),
  };
}

function memoryStorage(initial: string | null = null) {
  let token = initial;
  const storage: TokenStorage = {
    getRefreshToken: () => Promise.resolve(token),
    setRefreshToken: (t) => {
      token = t;
      return Promise.resolve();
    },
    clear: () => {
      token = null;
      return Promise.resolve();
    },
  };
  return { storage, peek: () => token };
}

function setup(
  initialToken: string | null,
  handler: (url: string, body: unknown) => ApiResponseLike | Promise<ApiResponseLike>,
  now = () => 1_000_000,
) {
  const mem = memoryStorage(initialToken);
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl: ApiFetch = async (url, init) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, headers: init.headers ?? {}, body });
    return handler(url, body);
  };
  const session = createSessionManager({
    baseUrl: 'https://api.test',
    storage: mem.storage,
    fetch: fetchImpl,
    now,
  });
  return { session, mem, calls };
}

describe('session manager', () => {
  it('login asks for body-token mode, keeps the refresh token in storage and the user in memory', async () => {
    const { session, mem, calls } = setup(null, () => res(200, sessionBody(1)));
    await session.login({ identifier: 'max', password: 'pw' });
    expect(calls[0]?.headers['x-refresh-mode']).toBe('body');
    expect(mem.peek()).toBe('refresh-1');
    expect(session.getUser()?.username).toBe('max');
    expect(session.isSignedIn()).toBe(true);
  });

  it('restore: no stored token means signed out, without calling the server', async () => {
    const { session, calls } = setup(null, () => res(500));
    await expect(session.restore()).resolves.toEqual({ status: 'signedOut' });
    expect(calls).toHaveLength(0);
  });

  it('restore: rotates the stored token and signs in', async () => {
    const { session, mem, calls } = setup('refresh-0', () => res(200, sessionBody(1)));
    await expect(session.restore()).resolves.toEqual({ status: 'signedIn' });
    expect(calls[0]?.body).toEqual({ refreshToken: 'refresh-0' });
    expect(mem.peek()).toBe('refresh-1');
  });

  it('restore: a rejected token signs out and wipes storage; the signed-out hook runs', async () => {
    const { session, mem } = setup('refresh-0', () =>
      res(401, { message: 'Invalid refresh token' }),
    );
    const hook = vi.fn();
    session.onSignedOut(hook);
    await expect(session.restore()).resolves.toEqual({ status: 'signedOut' });
    expect(mem.peek()).toBeNull();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('restore: a network failure keeps the token and reports offline', async () => {
    const { session, mem } = setup('refresh-0', () =>
      Promise.reject(new TypeError('Network request failed')),
    );
    await expect(session.restore()).resolves.toEqual({ status: 'offline' });
    expect(mem.peek()).toBe('refresh-0');
  });

  it('refreshes once for a burst of requests when the access token is about to expire', async () => {
    let t = 1_000_000;
    const { session, calls } = setup(
      null,
      (url) =>
        url.endsWith('/auth/login')
          ? res(200, sessionBody(1, 60_000))
          : res(200, sessionBody(2, 15 * 60_000, t)),
      () => t,
    );
    await session.login({ identifier: 'max', password: 'pw' });
    t += 45_000; // inside the 30 s margin of a 60 s token
    const tokens = await Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken(),
    ]);
    expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('authedFetch adds the bearer token and retries once after a 401', async () => {
    let apiCalls = 0;
    const { session, calls } = setup(null, (url) => {
      if (url.endsWith('/auth/login')) return res(200, sessionBody(1));
      if (url.endsWith('/auth/refresh')) return res(200, sessionBody(2));
      apiCalls += 1;
      return apiCalls === 1 ? res(401) : res(200, { ok: true });
    });
    await session.login({ identifier: 'max', password: 'pw' });
    const out = await session.authedFetch('https://api.test/me', { headers: {} });
    expect(out.status).toBe(200);
    const api = calls.filter((c) => c.url.endsWith('/me'));
    expect(api.map((c) => c.headers['Authorization'])).toEqual([
      'Bearer access-1',
      'Bearer access-2',
    ]);
  });

  it('getAccessToken throws NotSignedInError when there is no session at all', async () => {
    const { session } = setup(null, () => res(500));
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('logout removes the token and runs the hook even when the server is unreachable', async () => {
    const { session, mem, calls } = setup(null, (url) =>
      url.endsWith('/auth/login')
        ? res(200, sessionBody(1))
        : Promise.reject(new TypeError('offline')),
    );
    await session.login({ identifier: 'max', password: 'pw' });
    const hook = vi.fn();
    session.onSignedOut(hook);
    await session.logout();
    expect(calls.at(-1)?.body).toEqual({ refreshToken: 'refresh-1' });
    expect(mem.peek()).toBeNull();
    expect(session.isSignedIn()).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('restore: a 5xx or an unparseable answer is an error (token kept), not "offline"', async () => {
    const down = setup('refresh-0', () => res(503, { message: 'unavailable' }));
    await expect(down.session.restore()).resolves.toMatchObject({ status: 'error' });
    expect(down.mem.peek()).toBe('refresh-0');

    const stale = setup('refresh-0', () => res(200, { accessToken: 'x' })); // no refreshToken: old API
    await expect(stale.session.restore()).resolves.toMatchObject({ status: 'error' });
    expect(stale.mem.peek()).toBe('refresh-0');
  });

  it('logout during an in-flight refresh signs out at once, never flashes signed-in, and revokes both tokens', async () => {
    let releaseRefresh: (r: ApiResponseLike) => void = () => undefined;
    const { session, mem, calls } = setup('refresh-0', (url) => {
      if (url.endsWith('/auth/refresh')) {
        return new Promise<ApiResponseLike>((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return res(200, {});
    });
    const hook = vi.fn();
    session.onSignedOut(hook);
    const signedInSeen = vi.fn();
    session.subscribe(() => {
      if (session.isSignedIn()) signedInSeen();
    });

    const restoring = session.restore();
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/auth/refresh'))).toBe(true));
    await session.logout(); // user taps "Log out" while the refresh is still pending
    expect(session.isSignedIn()).toBe(false);
    expect(mem.peek()).toBeNull();

    releaseRefresh(res(200, sessionBody(1))); // the refresh finally lands, too late
    await expect(restoring).resolves.toEqual({ status: 'signedOut' });

    expect(session.isSignedIn()).toBe(false);
    expect(mem.peek()).toBeNull();
    expect(signedInSeen).not.toHaveBeenCalled();
    expect(hook).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      const revoked = calls
        .filter((c) => c.url.endsWith('/auth/logout'))
        .map((c) => (c.body as { refreshToken: string }).refreshToken);
      // the token that was stored when the user tapped, and the one the late refresh rotated to
      expect(revoked.sort()).toEqual(['refresh-0', 'refresh-1']);
    });
  });

  it('a refresh that finishes after a newer login does not overwrite it, and ends its own session', async () => {
    let releaseRefresh: (r: ApiResponseLike) => void = () => undefined;
    const { session, mem, calls } = setup('refresh-old', (url) => {
      if (url.endsWith('/auth/refresh')) {
        return new Promise<ApiResponseLike>((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return res(200, sessionBody(9));
    });
    const restoring = session.restore();
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/auth/refresh'))).toBe(true));
    await session.login({ identifier: 'max', password: 'pw' });
    releaseRefresh(res(200, sessionBody(1)));
    await restoring;

    expect(mem.peek()).toBe('refresh-9');
    expect(session.isSignedIn()).toBe(true);
    await expect(session.getAccessToken()).resolves.toBe('access-9');
    // The session the stale refresh rotated into is revoked on the server, not left dangling.
    await vi.waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.endsWith('/auth/logout') &&
            (c.body as { refreshToken: string }).refreshToken === 'refresh-1',
        ),
      ).toBe(true),
    );
  });

  it('a request that never answers times out as offline instead of hanging restore()', async () => {
    const mem = memoryStorage('refresh-0');
    const hang: ApiFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
      });
    const session = createSessionManager({
      baseUrl: 'https://api.test',
      storage: mem.storage,
      fetch: hang,
      authTimeoutMs: 20,
    });
    await expect(session.restore()).resolves.toEqual({ status: 'offline' });
    expect(mem.peek()).toBe('refresh-0');
  });

  it('logout completes locally and returns quickly even if the server never answers', async () => {
    const mem = memoryStorage('refresh-0');
    const hang: ApiFetch = () => new Promise(() => undefined);
    const session = createSessionManager({
      baseUrl: 'https://api.test',
      storage: mem.storage,
      fetch: hang,
      authTimeoutMs: 60_000,
      logoutWaitMs: 20,
    });
    const hook = vi.fn();
    session.onSignedOut(hook);
    await session.logout();
    expect(mem.peek()).toBeNull();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(session.isSignedIn()).toBe(false);
  });

  it('measures token lifetime from the token itself, so a fast device clock does not cause a refresh per call', async () => {
    // btoa is global in Node 22 and in React Native; build base64url from it.
    const b64 = (o: object) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = `${b64({ alg: 'HS256' })}.${b64({ iat: 5_000_000, exp: 5_000_900 })}.sig`;
    let refreshCalls = 0;
    // The server says the token expires at 5_000_900 s; this device's clock claims it is
    // already an hour later.
    const clock = 5_000_000_000 + 3_600_000;
    const { session } = setup(
      null,
      (url) => {
        if (url.endsWith('/auth/refresh')) refreshCalls += 1;
        return res(200, {
          ...sessionBody(1),
          accessToken: jwt,
          accessTokenExpiresAt: new Date(5_000_900_000).toISOString(),
        });
      },
      () => clock,
    );
    await session.login({ identifier: 'max', password: 'pw' });
    await session.getAccessToken();
    await session.getAccessToken();
    expect(refreshCalls).toBe(0);
  });

  it('exposes a generation that changes when the session is replaced or ended', async () => {
    const { session } = setup(null, () => res(200, sessionBody(1)));
    const g0 = session.generation();
    await session.login({ identifier: 'max', password: 'pw' });
    const g1 = session.generation();
    await session.logout();
    expect(g1).toBeGreaterThan(g0);
    expect(session.generation()).toBeGreaterThan(g1);
  });
});
