import { describe, expect, it } from 'vitest';
import { searchQuerySchema, searchTerms, snippetParts } from './search.js';

describe('search (CHAT-072)', () => {
  it('splits the snippet into plain and matched parts', () => {
    expect(snippetParts('see \u0001budget\u0002 for \u0001Q3\u0002')).toEqual([
      { text: 'see ', match: false },
      { text: 'budget', match: true },
      { text: ' for ', match: false },
      { text: 'Q3', match: true },
    ]);
    expect(snippetParts('nothing matched')).toEqual([{ text: 'nothing matched', match: false }]);
  });

  it('reduces a search to words, in any language', () => {
    expect(searchTerms('Budget, Q3!')).toEqual(['budget', 'q3']);
    expect(searchTerms('Привет мир')).toEqual(['привет', 'мир']);
    expect(searchTerms('Grüße & straße')).toEqual(['grüße', 'straße']);
    expect(searchTerms('!!!')).toEqual([]);
  });

  it('validates the filters', () => {
    expect(searchQuerySchema.safeParse({ q: '  ' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'x', has: 'file' }).success).toBe(true);
    expect(searchQuerySchema.safeParse({ q: 'x', has: 'video' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'x', after: '2026-10-01T00:00:00Z' }).success).toBe(
      true,
    );
  });
});
