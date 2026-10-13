/** A random v4 UUID. Call ids must be UUIDs (the server validates them), and Hermes does not
 *  always provide `crypto.randomUUID`, so fall back to building one from random bytes. */
export function newCallId(
  random: () => number = Math.random,
  cryptoLike:
    | { randomUUID?: () => string; getRandomValues?: <T extends Uint8Array>(a: T) => T }
    | undefined = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto,
): string {
  const native = cryptoLike?.randomUUID?.();
  if (native) return native;
  const bytes = new Uint8Array(16);
  if (cryptoLike?.getRandomValues) cryptoLike.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
