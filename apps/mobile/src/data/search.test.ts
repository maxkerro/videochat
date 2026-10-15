import { describe, expect, it } from 'vitest';
import { afterFor, queryString } from './search';

describe('search helpers (CHAT-072)', () => {
  it('builds a query string from the defined, non-empty values, encoded', () => {
    expect(queryString({ q: 'a&b c', conversationId: undefined, has: '', limit: 200 })).toBe(
      '?q=a%26b%20c&limit=200',
    );
    expect(queryString({ before: undefined })).toBe('');
  });

  it('turns a date choice into an `after` instant', () => {
    const now = Date.parse('2026-03-10T12:00:00.000Z');
    expect(afterFor('any', now)).toBeUndefined();
    expect(afterFor('week', now)).toBe('2026-03-03T12:00:00.000Z');
  });
});
