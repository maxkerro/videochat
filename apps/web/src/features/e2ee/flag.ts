/**
 * CHAT-076 (spike): the end-to-end encryption prototype is off unless this browser opts in
 * (Settings -> Privacy, shown only when the server has `E2EE_PROTOTYPE` on). Kept in
 * localStorage: it's a per-browser experiment, like the device keys themselves.
 */
const KEY = 'videochat:e2ee-prototype';
const listeners = new Set<() => void>();

export function isE2eeEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function setE2eeEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the prototype just stays off.
  }
  listeners.forEach((l) => l());
}

export function subscribeE2eeFlag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
