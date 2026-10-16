import { onSignOut, runSignOutHooks } from './signOutHooks';

describe('signOutHooks', () => {
  it('runs every hook with the session, and a failing or stuck hook never blocks', async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const offs = [
        onSignOut(async (s) => void seen.push(`ok:${s.userId}`)),
        onSignOut(async () => {
          throw new Error('boom');
        }),
        onSignOut(() => new Promise(() => undefined)),
      ];
      const done = runSignOutHooks({ userId: 'u1', accessToken: 't', refresh: async () => null });
      await vi.advanceTimersByTimeAsync(3_000);
      await done;
      expect(seen).toEqual(['ok:u1']);
      offs.forEach((off) => off());
    } finally {
      vi.useRealTimers();
    }
  });
});
