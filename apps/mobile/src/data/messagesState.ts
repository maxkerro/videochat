import type { Message, MessagePage, Reaction } from '@videochat/shared';

/** What the conversation screen shows for one conversation: loaded history, oldest first. */
export interface MessagesState {
  messages: Message[];
  /** Whether older messages exist on the server than the oldest one loaded. */
  hasMore: boolean;
}

export const emptyMessages: MessagesState = { messages: [], hasMore: false };

/** Adds new messages and swaps in newer versions of ones already loaded (an edit, a delete, new
 *  reactions, a link preview), keeping everything sorted by `seq`. */
export function mergeMessages(
  state: MessagesState | undefined,
  incoming: Message[],
): MessagesState {
  const base = state ?? emptyMessages;
  if (incoming.length === 0) return base;
  const byId = new Map(base.messages.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return {
    ...base,
    messages: [...byId.values()].sort((a, b) => a.seq - b.seq),
  };
}

/** The first page of a conversation: everything the server sent becomes the whole state, except
 *  that older messages already loaded (further back than this page reaches) are kept. */
export function mergeLatestPage(
  state: MessagesState | undefined,
  page: MessagePage,
): MessagesState {
  const oldestInPage = page.messages[0]?.seq;
  // Cached history only stays if it joins the page without a hole (a phone that was offline for a
  // while has an old tail; showing it above a much newer page would hide the missing middle).
  const joins =
    state !== undefined &&
    state.messages.length > 0 &&
    (oldestInPage === undefined || state.messages.at(-1)!.seq >= oldestInPage - 1);
  const kept =
    state && joins && oldestInPage !== undefined
      ? state.messages.filter((m) => m.seq < oldestInPage)
      : joins
        ? (state?.messages ?? [])
        : [];
  // A message that fell out of the server's latest page but is still loaded locally stays as is;
  // `mergeMessages` replaces the ones the page covers.
  const merged = mergeMessages({ messages: kept, hasMore: false }, page.messages);
  return {
    messages: merged.messages,
    hasMore: kept.length > 0 ? (state?.hasMore ?? page.hasMore) : page.hasMore,
  };
}

/** Prepends an older page (scrolling back through history). */
export function prependOlder(state: MessagesState | undefined, page: MessagePage): MessagesState {
  const merged = mergeMessages(state, page.messages);
  return { messages: merged.messages, hasMore: page.hasMore };
}

export function setReactions(
  state: MessagesState | undefined,
  messageId: string,
  reactions: Reaction[],
): MessagesState | undefined {
  if (!state?.messages.some((m) => m.id === messageId)) return state;
  return {
    ...state,
    messages: state.messages.map((m) => {
      if (m.id !== messageId) return m;
      const { reactions: _old, ...rest } = m;
      return reactions.length ? { ...rest, reactions } : rest;
    }),
  };
}
