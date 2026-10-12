import { ApiError, type Message } from '@videochat/shared';
import { describe, expect, it, vi } from 'vitest';
import type { OutboxItem } from '../db/store';
import { createOutboxRunner, flushOutbox, type FlushDeps } from './flush';

const item = (id: string, state: OutboxItem['state'] = 'queued'): OutboxItem => ({
  clientMsgId: id,
  conversationId: 'c',
  body: id,
  replyToId: null,
  queuedAt: 0,
  state,
  error: null,
});

function setup(items: OutboxItem[], send: (i: OutboxItem) => Promise<Message>) {
  const queue = [...items];
  const sentOrder: string[] = [];
  const failed: Record<string, string> = {};
  const deps: FlushDeps = {
    list: () => Promise.resolve([...queue]),
    send,
    remove: (id) => {
      queue.splice(
        queue.findIndex((q) => q.clientMsgId === id),
        1,
      );
      return Promise.resolve();
    },
    markFailed: (id, error) => {
      failed[id] = error;
      const q = queue.find((x) => x.clientMsgId === id);
      if (q) q.state = 'failed';
      return Promise.resolve();
    },
    onSent: (i) => {
      sentOrder.push(i.clientMsgId);
    },
  };
  return { deps, queue, sentOrder, failed };
}

const ok = (i: OutboxItem) => Promise.resolve({ id: i.clientMsgId } as unknown as Message);

describe('flushOutbox', () => {
  it('sends everything in order and empties the queue', async () => {
    const s = setup([item('a'), item('b'), item('c')], ok);
    await expect(flushOutbox(s.deps)).resolves.toEqual({ sent: 3, stopped: false });
    expect(s.sentOrder).toEqual(['a', 'b', 'c']);
    expect(s.queue).toEqual([]);
  });

  it('stops at the first network failure so later messages never overtake it', async () => {
    const send = vi.fn((i: OutboxItem) =>
      i.clientMsgId === 'b' ? Promise.reject(new TypeError('Network request failed')) : ok(i),
    );
    const s = setup([item('a'), item('b'), item('c')], send);
    await expect(flushOutbox(s.deps)).resolves.toEqual({ sent: 1, stopped: true });
    expect(s.sentOrder).toEqual(['a']);
    expect(s.queue.map((q) => q.clientMsgId)).toEqual(['b', 'c']);
    expect(send).toHaveBeenCalledTimes(2); // c was never tried
  });

  it('treats 5xx and 429 as "try later", not as a refusal', async () => {
    for (const status of [500, 502, 429, 408]) {
      const s = setup([item('a')], () => Promise.reject(new ApiError(status, 'x')));
      await expect(flushOutbox(s.deps)).resolves.toEqual({ sent: 0, stopped: true });
      expect(s.failed).toEqual({});
    }
  });

  it('marks a refused message failed, keeps it, and carries on with the rest', async () => {
    const s = setup([item('a'), item('b')], (i) =>
      i.clientMsgId === 'a' ? Promise.reject(new ApiError(403, 'Not a member')) : ok(i),
    );
    await expect(flushOutbox(s.deps)).resolves.toEqual({ sent: 1, stopped: false });
    expect(s.failed).toEqual({ a: 'Not a member' });
    expect(s.queue.map((q) => [q.clientMsgId, q.state])).toEqual([['a', 'failed']]);
  });

  it('leaves already-failed messages alone until they are requeued', async () => {
    const send = vi.fn(ok);
    const s = setup([item('a', 'failed'), item('b')], send);
    await flushOutbox(s.deps);
    expect(s.sentOrder).toEqual(['b']);
  });
});

describe('createOutboxRunner', () => {
  it('never runs two flushes at once, and picks up what was queued mid-flush', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup([item('a')], async (i) => {
      if (i.clientMsgId === 'a') await gate;
      return { id: i.clientMsgId } as unknown as Message;
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const send = s.deps.send;
    s.deps.send = async (i) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        return await send(i);
      } finally {
        concurrent -= 1;
      }
    };
    const runner = createOutboxRunner(s.deps);
    const first = runner.flush();
    await vi.waitFor(() => expect(concurrent).toBe(1));
    s.queue.push(item('b')); // typed while 'a' is still uploading
    const second = runner.flush(); // asked again mid-flush
    release();
    await Promise.all([first, second]);
    expect(s.sentOrder).toEqual(['a', 'b']);
    expect(maxConcurrent).toBe(1);
  });
});
