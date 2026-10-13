import { registerPushDevice, unregisterPushDevice } from '../data/api';

/** The token this install last registered for the signed-in account (in memory only). */
let registered: string | null = null;

export async function registerToken(platform: 'android' | 'ios', token: string): Promise<void> {
  if (registered === token) return;
  await registerPushDevice(platform, token);
  registered = token;
}

/** How long sign-out waits for the server to forget this phone. */
const UNREGISTER_WAIT_MS = 2_000;

/**
 * Called before sign-out, while the session can still authenticate: the server stops pushing this
 * account's messages to this phone. Bounded and best effort -- an offline sign-out still signs out;
 * the token then moves to the next account that registers on this phone.
 */
export async function unregisterToken(): Promise<void> {
  const token = registered;
  registered = null;
  if (!token) return;
  await Promise.race([
    unregisterPushDevice(token).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, UNREGISTER_WAIT_MS)),
  ]);
}

export function forgetRegistration(): void {
  registered = null;
}
