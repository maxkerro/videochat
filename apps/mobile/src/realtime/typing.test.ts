import { beforeEach, describe, expect, it } from 'vitest';
import {
  TYPING_EXPIRY_MS,
  clearTyping,
  noteTyping,
  pruneTyping,
  resetTyping,
  typingLabel,
  typingNames,
} from './typing';

describe('typing store', () => {
  beforeEach(() => resetTyping());

  it('lists who is typing, and drops entries that lapse', () => {
    noteTyping('c', 'a', 'Anna', 1_000);
    expect(typingNames('c', 1_000)).toEqual(['Anna']);
    expect(typingNames('c', 1_000 + TYPING_EXPIRY_MS)).toEqual([]);
    expect(pruneTyping(1_000 + TYPING_EXPIRY_MS)).toBe(true);
    expect(pruneTyping()).toBe(false);
  });

  it('a new signal extends the entry; a sent message clears it', () => {
    noteTyping('c', 'a', 'Anna', 1_000);
    noteTyping('c', 'a', 'Anna', 6_000);
    expect(typingNames('c', 8_000)).toEqual(['Anna']);
    clearTyping('c', 'a');
    expect(typingNames('c', 8_000)).toEqual([]);
  });

  it('keeps conversations apart', () => {
    noteTyping('c1', 'a', 'Anna', 1_000);
    expect(typingNames('c2', 1_000)).toEqual([]);
  });
});

describe('typingLabel', () => {
  it('words one, two and many typers', () => {
    expect(typingLabel([])).toBeNull();
    expect(typingLabel(['Anna'])).toBe('Anna is typing…');
    expect(typingLabel(['Anna', 'Ben'])).toBe('Anna and Ben are typing…');
    expect(typingLabel(['A', 'B', 'C'])).toBe('3 people are typing…');
  });
});
