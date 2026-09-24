import type { ReactNode } from 'react';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;

/** Trailing punctuation is more often sentence punctuation than part of the URL
 *  ("see https://example.com." shouldn't link the period). */
function trimTrailingPunctuation(url: string): { url: string; trailing: string } {
  const match = /[).,!?;:'"]+$/.exec(url);
  if (!match) return { url, trailing: '' };
  return { url: url.slice(0, match.index), trailing: match[0] };
}

/**
 * CHAT-014: message bodies are always plain text and must never be rendered as HTML. This turns
 * bare http(s) URLs into safe links (`rel="noopener noreferrer"`, opened in a new tab); everything
 * else stays as plain text nodes, so there's no way for a message body to inject markup.
 */
export function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const { url, trailing } = trimTrailingPunctuation(raw);
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    nodes.push(
      <a key={key++} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    if (trailing) nodes.push(trailing);
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
