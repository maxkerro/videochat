import { presenceLabel } from './presence';

describe('presenceLabel (CHAT-034)', () => {
  const now = new Date('2026-10-05T15:00:00').getTime();
  const at = (iso: string) => ({
    userId: 'u',
    online: false,
    lastSeenAt: new Date(iso).toISOString(),
  });

  it('says online, or how long ago', () => {
    expect(presenceLabel({ userId: 'u', online: true, lastSeenAt: null }, now)).toBe('Online');
    expect(presenceLabel(at('2026-10-05T14:59:40'), now)).toBe('Last seen just now');
    expect(presenceLabel(at('2026-10-05T14:55:00'), now)).toBe('Last seen 5 min ago');
    expect(presenceLabel(at('2026-10-05T09:05:00'), now)).toMatch(/^Last seen today at /);
    expect(presenceLabel(at('2026-10-04T09:05:00'), now)).toMatch(/^Last seen yesterday at /);
    expect(presenceLabel(at('2026-09-20T09:05:00'), now)).toMatch(/^Last seen /);
  });

  it('says nothing when presence is hidden or unknown', () => {
    expect(presenceLabel(undefined, now)).toBeNull();
    expect(presenceLabel({ userId: 'u', online: false, lastSeenAt: null }, now)).toBeNull();
  });
});
