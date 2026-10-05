import { useSyncExternalStore } from 'react';

/**
 * CHAT-036: unsent composer text per conversation, kept in localStorage so it survives switching
 * chats and reloading. Keyed per user, so someone else signing in on this browser never sees it,
 * and cleared on sign-out.
 */
const PREFIX = 'videochat.drafts.';
const EVENT = 'videochat:drafts';

type Drafts = Record<string, string>;

function keyFor(userId: string) {
  return `${PREFIX}${userId}`;
}

function read(userId: string): Drafts {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Drafts) : {};
  } catch {
    return {};
  }
}

// useSyncExternalStore needs a stable snapshot per change, not a fresh object per read.
const cache = new Map<string, { raw: string | null; drafts: Drafts }>();
function snapshot(userId: string): Drafts {
  let raw: string | null;
  try {
    raw = localStorage.getItem(keyFor(userId));
  } catch {
    raw = null;
  }
  const hit = cache.get(userId);
  if (hit && hit.raw === raw) return hit.drafts;
  const drafts = read(userId);
  cache.set(userId, { raw, drafts });
  return drafts;
}

export function getDraft(userId: string | undefined, conversationId: string | undefined): string {
  if (!userId || !conversationId) return '';
  return snapshot(userId)[conversationId] ?? '';
}

export function saveDraft(
  userId: string | undefined,
  conversationId: string | undefined,
  text: string,
): void {
  if (!userId || !conversationId) return;
  const drafts = { ...read(userId) };
  if (text.trim()) drafts[conversationId] = text;
  else delete drafts[conversationId];
  try {
    if (Object.keys(drafts).length) localStorage.setItem(keyFor(userId), JSON.stringify(drafts));
    else localStorage.removeItem(keyFor(userId));
  } catch {
    return; // Storage full or blocked: the draft just isn't kept.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function clearDrafts(userId: string | undefined): void {
  if (!userId) return;
  try {
    localStorage.removeItem(keyFor(userId));
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  // Same tab (our own event) and other tabs (the storage event).
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

const EMPTY: Drafts = {};

/** All of a user's drafts, kept live across tabs. */
export function useDrafts(userId: string | undefined): Drafts {
  return useSyncExternalStore(
    subscribe,
    () => (userId ? snapshot(userId) : EMPTY),
    () => EMPTY,
  );
}
