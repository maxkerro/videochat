import { describe, expect, it } from 'vitest';
import { presenceLabel } from './presenceLabel';

const now = new Date('2026-10-13T12:00:00Z').getTime();
const p = (online: boolean, lastSeenAt: string | null) => ({
  userId: '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c',
  online,
  lastSeenAt,
});

describe('presenceLabel', () => {
  it('says nothing when presence is hidden or unknown', () => {
    expect(presenceLabel(undefined, now)).toBeNull();
    expect(presenceLabel(p(false, null), now)).toBeNull();
  });
  it('online and recent last-seen', () => {
    expect(presenceLabel(p(true, null), now)).toBe('Online');
    expect(presenceLabel(p(false, '2026-10-13T11:59:30Z'), now)).toBe('Last seen just now');
    expect(presenceLabel(p(false, '2026-10-13T11:45:00Z'), now)).toBe('Last seen 15 min ago');
  });
});
