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
