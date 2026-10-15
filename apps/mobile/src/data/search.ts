import type { SearchHas } from '@videochat/shared';

/** CHAT-072: the search screen's "Date" choices. */
export type SearchWhen = 'any' | 'week' | 'month' | 'year';

const DAY = 24 * 60 * 60 * 1000;
const SPAN: Record<Exclude<SearchWhen, 'any'>, number> = { week: 7, month: 31, year: 366 };

/** The `after` instant for a "Date" choice (undefined for any time). */
export function afterFor(when: SearchWhen, now = Date.now()): string | undefined {
  return when === 'any' ? undefined : new Date(now - SPAN[when] * DAY).toISOString();
}

export const WHEN_OPTIONS: { value: SearchWhen; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: 'week', label: 'Past week' },
  { value: 'month', label: 'Past month' },
  { value: 'year', label: 'Past year' },
];

export const HAS_OPTIONS: { value: SearchHas | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'file', label: 'Files' },
  { value: 'image', label: 'Photos' },
];

export const MIN_SEARCH_LENGTH = 2;

/** `?a=1&b=2` from the defined, non-empty values (React Native's URLSearchParams is partial). */
export function queryString(values: Record<string, string | number | undefined>): string {
  const parts = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
