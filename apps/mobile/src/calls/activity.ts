/** CHAT-060: whether a call is in progress, as a tiny store the realtime provider listens to (it
 *  keeps the socket open in the background while this is true). */
let active = false;
const listeners = new Set<(active: boolean) => void>();

export function setCallActive(next: boolean): void {
  if (next === active) return;
  active = next;
  for (const l of listeners) l(next);
}

export const isCallActive = () => active;

export function subscribeCallActive(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
