import { searchResponseSchema, type SearchQuery, type SearchResponse } from '@videochat/shared';
import { apiGet } from '../../lib/api';

/** CHAT-072: search the messages and files of every conversation you're in. */
export function searchMessages(accessToken: string, query: SearchQuery): Promise<SearchResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return apiGet(`/search?${params.toString()}`, searchResponseSchema, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export type SearchWhen = 'any' | 'week' | 'month' | 'year';

const DAY = 24 * 60 * 60 * 1000;
const SPAN: Record<Exclude<SearchWhen, 'any'>, number> = { week: 7, month: 31, year: 366 };

/** The `after` instant for a "Date" choice (undefined for any time). */
export function afterFor(when: SearchWhen, now = Date.now()): string | undefined {
  return when === 'any' ? undefined : new Date(now - SPAN[when] * DAY).toISOString();
}
