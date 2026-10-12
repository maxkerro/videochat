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
  /** Consecutive 401s per message, kept by the runner across runs (see `MAX_UNAUTHORIZED`). */
  unauthorized?: Map<string, number>;
}

/** How many 401s in a row one message may get before it is marked failed instead of retried. */
export const MAX_UNAUTHORIZED = 3;

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
export async function flushOutbox(
  deps: FlushDeps,
  /** The generation the caller started under; defaults to the current one. The runner passes its
   *  own so that a later pass of the same run can never adopt a newer account's generation. */
  startedUnder: number = deps.generation(),
): Promise<FlushResult> {
  let sent = 0;
  for (const item of await deps.list()) {
    if (item.state !== 'queued') continue;
    // The account changed since this run began (sign-out wipes the outbox, but not the list this
    // loop is walking): the rest belongs to the old account and must never go out as the new one.
    if (deps.generation() !== startedUnder) return { sent, stopped: true };
    try {
      const message = await deps.send(item);
      await deps.remove(item.clientMsgId);
      deps.unauthorized?.delete(item.clientMsgId);
      await deps.onSent(item, message, startedUnder);
      sent += 1;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && deps.unauthorized) {
        // Normally a refresh racing the request. If it keeps happening for this message, stop
        // blocking everything behind it: mark it failed so the person can retry or delete it.
        const count = (deps.unauthorized.get(item.clientMsgId) ?? 0) + 1;
        if (count >= MAX_UNAUTHORIZED) {
          deps.unauthorized.delete(item.clientMsgId);
          await deps.markFailed(item.clientMsgId, 'Not signed in. Log in again, then retry.');
          continue;
        }
        deps.unauthorized.set(item.clientMsgId, count);
        return { sent, stopped: true };
      }
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
 * it runs again right after, so a message queued mid-flush is still picked up. A run belongs to
 * the session generation it started under for all of its passes; if the account changed, it ends,
 * and a request that arrived meanwhile starts a fresh run for the new account.
 */
export function createOutboxRunner(deps: FlushDeps & { onChange?: () => void }) {
  let running: { generation: number; promise: Promise<FlushResult> } | null = null;
  let again = false;
  const unauthorized = new Map<string, number>();
  const runDeps: FlushDeps = { ...deps, unauthorized };

  async function loop(generation: number): Promise<FlushResult> {
    let total = 0;
    for (;;) {
      again = false;
      const result = await flushOutbox(runDeps, generation);
      total += result.sent;
      deps.onChange?.();
      // After a network stop, retrying straight away would just fail again.
      if (result.stopped) return { sent: total, stopped: true };
      if (!again) return { sent: total, stopped: false };
      // Another pass was asked for -- but not for an account that has since been replaced.
      if (deps.generation() !== generation) return { sent: total, stopped: true };
    }
  }

  function flush(): Promise<FlushResult> {
    const generation = deps.generation();
    if (running) {
      if (running.generation === generation) {
        again = true;
        return running.promise;
      }
      // A run for a previous account is winding down: the new account's run starts after it.
      return running.promise.then(flush, flush);
    }
    const promise = loop(generation).finally(() => {
      running = null;
      unauthorized.clear();
    });
    running = { generation, promise };
    return promise;
  }

  return { flush };
}
