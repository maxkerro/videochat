import type { ConversationSummary } from '@videochat/shared';
import { useEffect } from 'react';

const BASE_TITLE = 'Videochat';

/** Unread messages across conversations that aren't muted. */
export function totalUnread(conversations: ConversationSummary[]): number {
  return conversations.reduce(
    (sum, c) => (c.muted ? sum : sum + Math.max(0, c.lastSeq - c.lastReadSeq)),
    0,
  );
}

export function titleFor(unread: number): string {
  if (unread <= 0) return BASE_TITLE;
  return `(${unread > 99 ? '99+' : unread}) ${BASE_TITLE}`;
}

let originalFavicon: string | null = null;

/** The favicon with a red count badge drawn on it, as a data URL (null if canvas isn't there). */
function badgedFavicon(unread: number, img: HTMLImageElement): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, 64, 64);
  ctx.fillStyle = '#d93636';
  ctx.beginPath();
  ctx.arc(46, 18, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(unread > 9 ? '9+' : String(unread), 46, 19);
  return canvas.toDataURL('image/png');
}

/** CHAT-035: unread count in the tab title and as a badge on the favicon. */
export function useUnreadBadge(conversations: ConversationSummary[] | undefined): void {
  const unread = conversations ? totalUnread(conversations) : 0;
  useEffect(() => {
    document.title = titleFor(unread);
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    originalFavicon ??= link.href;
    if (unread === 0) {
      link.href = originalFavicon;
      return;
    }
    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      const url = badgedFavicon(unread, img);
      if (url) link.href = url;
    };
    img.src = originalFavicon;
    return () => {
      cancelled = true;
    };
  }, [unread]);
  useEffect(
    () => () => {
      document.title = BASE_TITLE;
    },
    [],
  );
}
