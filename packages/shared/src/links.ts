import { z } from 'zod';

/** http(s) URLs in plain text -- the same rule the web client linkifies with (CHAT-014). */
export const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;

/** Trailing punctuation is more often sentence punctuation than part of the URL
 *  ("see https://example.com." shouldn't include the period). */
export function trimTrailingPunctuation(url: string): { url: string; trailing: string } {
  const match = /[).,!?;:'"]+$/.exec(url);
  if (!match) return { url, trailing: '' };
  return { url: url.slice(0, match.index), trailing: match[0] };
}

/** CHAT-031: the URL a message's link preview is for -- the first one in it, if any. */
export function firstUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const match of text.matchAll(URL_PATTERN)) {
    const { url } = trimTrailingPunctuation(match[0]);
    if (url.length <= 2048) return url;
  }
  return null;
}

/** An absolute http(s) URL -- `z.url()` alone also accepts `javascript:`, `data:` and friends. */
export const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

/** CHAT-031: what a link preview card shows, from the page's OpenGraph (or plain HTML) tags. */
export const linkPreviewSchema = z.object({
  url: httpUrlSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(500).nullable(),
  siteName: z.string().max(100).nullable(),
  /** Always https; shown with no referrer. */
  imageUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .nullable(),
});
export type LinkPreview = z.infer<typeof linkPreviewSchema>;

export const linkPreviewQuerySchema = z.object({ url: httpUrlSchema });

/** GET /link-preview answers 200 with `{ preview: null }` when there's nothing to show. */
export const linkPreviewResponseSchema = z.object({ preview: linkPreviewSchema.nullable() });
export type LinkPreviewResponse = z.infer<typeof linkPreviewResponseSchema>;
