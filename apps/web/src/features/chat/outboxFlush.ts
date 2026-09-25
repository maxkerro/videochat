import type { Message } from '@videochat/shared';
import { ApiError } from '../../lib/api';
import type { OutboxMessage } from '../../lib/outbox';

export interface OutboxFlushDeps {
  listQueued: () => Promise<OutboxMessage[]>;
  send: (conversationId: string, clientMsgId: string, body: string) => Promise<Message>;
  remove: (clientMsgId: string) => Promise<void>;
  /** Called for each message actually sent, so the caller can merge it into wherever the UI reads
   *  messages from (the query cache) exactly as it would a live `message.new` event. */
  onSent: (message: Message) => void;
}

/**
 * CHAT-017: sends everything in the offline outbox, in the order it was queued (see
 * `listAllQueuedMessages`), stopping at the first one that still can't be sent rather than
 * skipping ahead -- that's what "sent in order" means for a person who queued several messages
 * while offline. `clientMsgId` makes each send idempotent, so a message that actually reached the
 * server just before the connection dropped (and is only in the outbox because the *response*
 * never arrived) is returned unchanged rather than duplicated.
 */
export async function flushOutbox(deps: OutboxFlushDeps): Promise<void> {
  const queued = await deps.listQueued();
  for (const item of queued) {
    try {
      const message = await deps.send(item.conversationId, item.clientMsgId, item.body);
      await deps.remove(item.clientMsgId);
      deps.onSent(message);
    } catch (error) {
      if (error instanceof ApiError) {
        // The server was reached and said no (e.g. removed from the conversation while offline,
        // or the message now fails validation) -- that will never succeed by itself, so drop it
        // and let the rest of the queue go out rather than blocking everything behind it forever.
        await deps.remove(item.clientMsgId);
        continue;
      }
      // Still offline, or a transient network error: stop here so later messages don't jump the
      // queue ahead of this one -- the next reconnect (or the next `online` event) retries from
      // exactly this message.
      break;
    }
  }
}
