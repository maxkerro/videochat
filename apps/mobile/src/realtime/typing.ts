import { useEffect, useSyncExternalStore } from 'react';

/** A "typing" signal is refreshed by the sender about every 3 s; without a refresh it lapses. */
export const TYPING_EXPIRY_MS = 6_000;

interface Entry {
  name: string;
  expiresAt: number;
}

/** conversationId -> userId -> entry. Ephemeral and never persisted. */
let state = new Map<string, Map<string, Entry>>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;
const emit = () => {
  snapshotVersion += 1;
  for (const l of listeners) l();
};

export function noteTyping(
  conversationId: string,
  userId: string,
  name: string,
  now: number = Date.now(),
): void {
  const inConversation = new Map(state.get(conversationId) ?? []);
  inConversation.set(userId, { name, expiresAt: now + TYPING_EXPIRY_MS });
  state = new Map(state).set(conversationId, inConversation);
  emit();
}

/** They sent their message, so they are no longer "typing". */
export function clearTyping(conversationId: string, userId: string): void {
  const inConversation = state.get(conversationId);
  if (!inConversation?.has(userId)) return;
  const next = new Map(inConversation);
  next.delete(userId);
  state = new Map(state);
  if (next.size === 0) state.delete(conversationId);
  else state.set(conversationId, next);
  emit();
}

export function resetTyping(): void {
  if (state.size === 0) return;
  state = new Map();
  emit();
}

/** Drops lapsed entries; returns whether anything changed. */
export function pruneTyping(now: number = Date.now()): boolean {
  let changed = false;
  const next = new Map<string, Map<string, Entry>>();
  for (const [conversationId, entries] of state) {
    const kept = new Map([...entries].filter(([, e]) => e.expiresAt > now));
    if (kept.size !== entries.size) changed = true;
    if (kept.size > 0) next.set(conversationId, kept);
  }
  if (changed) {
    state = next;
    emit();
  }
  return changed;
}

export function typingNames(conversationId: string, now: number = Date.now()): string[] {
  return [...(state.get(conversationId) ?? [])]
    .filter(([, e]) => e.expiresAt > now)
    .map(([, e]) => e.name);
}

/** "Anna is typing…", "Anna and Ben are typing…", "3 people are typing…". */
export function typingLabel(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}

/** Who is typing in this conversation right now (the screen re-renders as signals come and go). */
export function useTypingLabel(conversationId: string): string | null {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshotVersion,
  );
  useEffect(() => {
    const timer = setInterval(() => pruneTyping(), 2_000);
    return () => clearInterval(timer);
  }, []);
  return typingLabel(typingNames(conversationId));
}
