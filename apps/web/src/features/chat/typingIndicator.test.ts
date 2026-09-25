import {
  formatTypingLabel,
  pruneExpiredTyping,
  TYPING_EXPIRY_MS,
  withTypingEvent,
  type TypingEntry,
} from './typingIndicator';

describe('withTypingEvent', () => {
  it('adds a new entry without mutating the input map', () => {
    const before = new Map<string, TypingEntry>();
    const after = withTypingEvent(before, { userId: 'u1', displayName: 'Anna' }, 1000);

    expect(before.size).toBe(0);
    expect(after.get('u1')).toEqual({ displayName: 'Anna', lastSeenAt: 1000 });
  });

  it("refreshes an existing entry's lastSeenAt", () => {
    const before = new Map<string, TypingEntry>([['u1', { displayName: 'Anna', lastSeenAt: 0 }]]);
    const after = withTypingEvent(before, { userId: 'u1', displayName: 'Anna' }, 5000);

    expect(after.get('u1')).toEqual({ displayName: 'Anna', lastSeenAt: 5000 });
  });
});

describe('pruneExpiredTyping', () => {
  it('drops entries not refreshed within TYPING_EXPIRY_MS', () => {
    const entries = new Map<string, TypingEntry>([
      ['stale', { displayName: 'Anna', lastSeenAt: 0 }],
      ['fresh', { displayName: 'Ben', lastSeenAt: 4000 }],
    ]);

    const pruned = pruneExpiredTyping(entries, TYPING_EXPIRY_MS);

    expect(pruned.has('stale')).toBe(false);
    expect(pruned.has('fresh')).toBe(true);
  });

  it('returns the exact same map instance when nothing expired', () => {
    const entries = new Map<string, TypingEntry>([['u1', { displayName: 'Anna', lastSeenAt: 0 }]]);

    expect(pruneExpiredTyping(entries, TYPING_EXPIRY_MS - 1)).toBe(entries);
  });
});

describe('formatTypingLabel', () => {
  it('returns null for no typers', () => {
    expect(formatTypingLabel([])).toBeNull();
  });

  it('names a single typer', () => {
    expect(formatTypingLabel(['Anna'])).toBe('Anna is typing…');
  });

  it('joins two typers with "and"', () => {
    expect(formatTypingLabel(['Anna', 'Ben'])).toBe('Anna and Ben are typing…');
  });

  it('joins three typers naturally (still named per "up to 3 names")', () => {
    expect(formatTypingLabel(['Anna', 'Ben', 'Cara'])).toBe('Anna, Ben and Cara are typing…');
  });

  it('collapses four or more typers to the generic label', () => {
    expect(formatTypingLabel(['Anna', 'Ben', 'Cara', 'Dev'])).toBe('Several people are typing…');
    expect(formatTypingLabel(['Anna', 'Ben', 'Cara', 'Dev', 'Eli'])).toBe(
      'Several people are typing…',
    );
  });
});
