import { decodeCursor, encodeCursor, prefixQuery } from './search.service.js';

describe('search helpers (CHAT-072)', () => {
  it('turns words into an all-words prefix query, dropping tsquery syntax', () => {
    expect(prefixQuery('budget plan')).toBe('budget:* & plan:*');
    expect(prefixQuery("bud' | !x & (y)")).toBe('bud:* & x:* & y:*');
    expect(prefixQuery('Привет мир')).toBe('привет:* & мир:*');
    expect(prefixQuery('  &|!  ')).toBeNull();
  });

  it('round-trips a cursor and rejects tampered ones', () => {
    const at = new Date('2026-01-02T03:04:05.678Z');
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ createdAt: at, id });
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(
      decodeCursor(Buffer.from('nope|01ARZ3NDEKTSV4RRFFQ69G5FAV').toString('base64url')),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from(`${at.toISOString()}|' or 1=1`).toString('base64url')),
    ).toBeNull();
  });
});
