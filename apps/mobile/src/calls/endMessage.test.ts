import { describe, expect, it } from 'vitest';
import { endMessage, formatDuration } from './endMessage';

const peer = { id: 'p', displayName: 'Ben', avatarUrl: null };
const out = { direction: 'outgoing' as const, peer, startedAt: null };
const inc = { direction: 'incoming' as const, peer, startedAt: null };

describe('endMessage', () => {
  it('words missed and declined calls from the right side', () => {
    expect(endMessage(out, 'missed', 0)).toBe('Ben didn’t answer');
    expect(endMessage(inc, 'missed', 0)).toBe('Missed call from Ben');
    expect(endMessage(out, 'declined', 0)).toBe('Ben declined the call');
    expect(endMessage(inc, 'declined', 0)).toBeNull();
    expect(endMessage(inc, 'cancelled', 0)).toBe('Missed call from Ben');
    expect(endMessage(out, 'cancelled', 0)).toBeNull();
  });

  it('shows how long a finished call lasted', () => {
    expect(endMessage({ ...out, startedAt: 1_000 }, 'completed', 66_000)).toBe('Call ended · 1:05');
    expect(endMessage(out, 'completed', 5)).toBe('Call ended');
  });

  it('explains the other endings', () => {
    expect(endMessage(out, 'busy', 0)).toBe('Ben is on another call');
    expect(endMessage(out, 'unavailable', 0)).toBe('You can’t call Ben right now');
    expect(endMessage(inc, 'answered-elsewhere', 0)).toBe('Answered on another device');
    expect(endMessage(out, 'connection-lost', 0)).toBe('The call was disconnected');
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-5)).toBe('0:00');
  });
});
