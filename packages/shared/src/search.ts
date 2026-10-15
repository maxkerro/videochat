import { z } from 'zod';
import { messageSchema } from './schemas.js';

/*
 * CHAT-072: searching the messages and files in every conversation the person belongs to.
 */

export const SEARCH_PAGE_SIZE = 30;
export const SEARCH_QUERY_MAX = 200;

/** What a result can be narrowed to: anything with a file, or just photos. */
export const SEARCH_HAS = ['file', 'image'] as const;
export type SearchHas = (typeof SEARCH_HAS)[number];

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX),
  /** Only this conversation. */
  conversationId: z.uuid().optional(),
  /** Only messages sent by this person. */
  from: z.uuid().optional(),
  /** Only messages sent at or after / before these instants. */
  after: z.iso.datetime({ offset: true }).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  has: z.enum(SEARCH_HAS).optional(),
  /** From the previous page's `nextCursor`. */
  cursor: z.string().max(200).optional(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** Marks around the matched words in `snippet` (control characters, so they never collide with
 *  real text). Render the text between them highlighted -- as text, never as HTML. */
export const SEARCH_MARK_START = '\u0001';
export const SEARCH_MARK_END = '\u0002';

export const searchResultSchema = z.object({
  message: messageSchema,
  /** Who sent it (null for a deleted account). */
  senderName: z.string().nullable(),
  /** The matching part of the text (or file name), with the matches marked. */
  snippet: z.string(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  nextCursor: z.string().nullable(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** Splits a snippet into plain and highlighted parts, for rendering. */
export function snippetParts(snippet: string): Array<{ text: string; match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = [];
  let match = false;
  let text = '';
  for (const ch of snippet) {
    if (ch === SEARCH_MARK_START || ch === SEARCH_MARK_END) {
      if (text) parts.push({ text, match });
      text = '';
      match = ch === SEARCH_MARK_START;
    } else {
      text += ch;
    }
  }
  if (text) parts.push({ text, match });
  return parts;
}

/** The words of a search, as the server matches them (letters and digits; each a prefix). */
export function searchTerms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 10);
}
