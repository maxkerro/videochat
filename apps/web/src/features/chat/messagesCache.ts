import type { InfiniteData } from '@tanstack/react-query';
import type { Message, MessagePage } from '@videochat/shared';

export type MessagesData = InfiniteData<MessagePage, number | undefined>;

function upsertMessage(list: Message[], message: Message): Message[] {
  if (list.some((m) => m.id === message.id)) return list;
  return [...list, message].sort((a, b) => a.seq - b.seq);
}

/** Appends a live/sent/gap-synced message to the newest (last) loaded page -- the only page a new
 *  message can ever belong in, since pages before it are strictly older history. Shared between
 *  `ChatPane` (live `message.new` events and its own sends) and `RealtimeProvider` (CHAT-017 gap
 *  sync merges messages the same way, for a conversation that may not even be open right now). */
export function appendToLatestPage(
  data: MessagesData | undefined,
  message: Message,
): MessagesData | undefined {
  if (!data || data.pages.length === 0) return data;
  const pages = [...data.pages];
  const lastIndex = pages.length - 1;
  pages[lastIndex] = {
    ...pages[lastIndex]!,
    messages: upsertMessage(pages[lastIndex]!.messages, message),
  };
  return { ...data, pages };
}

/** CHAT-031/032: swaps in a newer version of a message already in the cache (a link preview
 *  arriving, an edit, a delete), wherever it's loaded. A message that isn't loaded is left
 *  alone -- it'll arrive fresh when that page is fetched. */
export function replaceMessage(
  data: MessagesData | undefined,
  message: Message,
): MessagesData | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page.messages.some((m) => m.id === message.id)) return page;
    changed = true;
    return { ...page, messages: page.messages.map((m) => (m.id === message.id ? message : m)) };
  });
  return changed ? { ...data, pages } : data;
}
