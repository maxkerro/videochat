import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock('../data/api', () => ({
  registerPushDevice: api.register,
  unregisterPushDevice: api.unregister,
}));

import { forgetRegistration, registerToken, unregisterToken } from './registration';

describe('push registration', () => {
  beforeEach(() => {
    forgetRegistration();
    api.register.mockReset().mockResolvedValue(undefined);
    api.unregister.mockReset().mockResolvedValue(undefined);
  });

  it('registers a token once', async () => {
    await registerToken('android', 't1');
    await registerToken('android', 't1');
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed registration', async () => {
    api.register.mockRejectedValueOnce(new Error('offline'));
    await expect(registerToken('android', 't1')).rejects.toThrow();
    await registerToken('android', 't1');
    expect(api.register).toHaveBeenCalledTimes(2);
  });

  it('unregisters the registered token', async () => {
    await registerToken('android', 't1');
    await unregisterToken();
    expect(api.unregister).toHaveBeenCalledWith('t1');
  });

  it('waits for an in-flight registration so its token is removed too', async () => {
    let done!: () => void;
    api.register.mockReturnValueOnce(new Promise<void>((r) => (done = r)));
    const reg = registerToken('android', 't2');
    const un = unregisterToken();
    done();
    await reg;
    await un;
    expect(api.unregister).toHaveBeenCalledWith('t2');
  });

  it('does nothing when nothing was registered', async () => {
    await unregisterToken();
    expect(api.unregister).not.toHaveBeenCalled();
  });
});
