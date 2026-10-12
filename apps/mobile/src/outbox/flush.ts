import { ApiError, type Message } from '@videochat/shared';
import type { OutboxItem } from '../db/store';

export interface FlushDeps {
  /** Unsent messages, oldest first. */
  list: () => Promise<OutboxItem[]>;
  send: (item: OutboxItem) => Promise<Message>;
  remove: (clientMsgId: string) => Promise<void>;
  markFailed: (clientMsgId: string, error: string) => Promise<void>;
  /** Called for each message the server accepted, so the UI can show the real message.
   *  `generation` is the session generation the run started under. */
  onSent: (item: OutboxItem, message: Message, generation: number) => void | Promise<void>;
  /** The current session generation (it changes on sign-out and sign-in). */
  generation: () => number;
}

export interface FlushResult {
  sent: number;
  /** True when a network problem stopped the run; the rest is still queued. */
  stopped: boolean;
}

/**
 * CHAT-053: sends the outbox in the order it was typed. A network failure stops the run so a later
 * message can never overtake an earlier one. The server answering "no" (the person was removed from
 * the group, the text is invalid) will never succeed by retrying, so that message is marked failed
 * -- kept, visible, retryable by hand -- and the ones behind it carry on. `clientMsgId` makes every
 * send idempotent: a message that reached the server just before the connection dropped comes back
 * unchanged instead of being posted twice.
 */
export async function flushOutbox(deps: FlushDeps): Promise<FlushResult> {
  let sent = 0;
  const startedUnder = deps.generation();
  for (const item of await deps.list()) {
    if (item.state !== 'queued') continue;
    // The account changed since this run began (sign-out wipes the outbox, but not the list this
    // loop is walking): the rest belongs to the old account and must never go out as the new one.
    if (deps.generation() !== startedUnder) return { sent, stopped: true };
    try {
      const message = await deps.send(item);
      await deps.remove(item.clientMsgId);
      await deps.onSent(item, message, startedUnder);
      sent += 1;
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        // Retryable by nature: a 401 (a refresh racing the request -- if the session really ended,
        // the sign-out wipe takes the outbox with it), a timeout, a rate limit.
        e.status !== 401 &&
        e.status !== 408 &&
        e.status !== 429
      ) {
        await deps.markFailed(item.clientMsgId, e.message);
        continue;
      }
      // Offline, timed out, or a 5xx/429: try again later, from this very message.
      return { sent, stopped: true };
    }
  }
  return { sent, stopped: false };
}

/**
 * Runs {@link flushOutbox} one run at a time. A flush requested while one is running is not lost:
 * it runs again right after, so a message queued mid-flush is still picked up.
 */
export function createOutboxRunner(deps: FlushDeps & { onChange?: () => void }) {
  let running: Promise<FlushResult> | null = null;
  let again = false;

  async function loop(): Promise<FlushResult> {
    let total = 0;
    for (;;) {
      again = false;
      const result = await flushOutbox(deps);
      total += result.sent;
      deps.onChange?.();
      // After a network stop, retrying straight away would just fail again.
      if (result.stopped) return { sent: total, stopped: true };
      if (!again) return { sent: total, stopped: false };
    }
  }

  return {
    flush(): Promise<FlushResult> {
      if (running) {
        again = true;
        return running;
      }
      running = loop().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
