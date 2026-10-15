import { mentionParts, trimTrailingPunctuation, URL_PATTERN } from '@videochat/shared';
import type { ReactNode } from 'react';

/**
 * CHAT-014: message bodies are always plain text and must never be rendered as HTML. This turns
 * bare http(s) URLs into safe links (`rel="noopener noreferrer"`, opened in a new tab); everything
 * else stays as plain text nodes, so there's no way for a message body to inject markup.
 */
export function linkify(text: string, mentions?: MentionStyle): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  // CHAT-073: plain runs may hold @mentions to highlight.
  const plain = (chunk: string) => {
    if (!mentions) {
      nodes.push(chunk);
      return;
    }
    for (const part of mentionParts(chunk, (u) => mentions(u) !== null)) {
      const className = part.mention ? mentions(part.mention) : null;
      nodes.push(
        className ? (
          <span key={key++} className={className}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      );
    }
  };
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const { url, trailing } = trimTrailingPunctuation(raw);
    if (start > lastIndex) plain(text.slice(lastIndex, start));
    nodes.push(
      <a key={key++} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    if (trailing) plain(trailing);
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) plain(text.slice(lastIndex));
  return nodes;
}

/** CHAT-073: the class to highlight `@username` with, or null when it isn't a mention. */
export type MentionStyle = (username: string) => string | null;
