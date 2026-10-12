import { ApiError, type Message } from '@videochat/shared';
import { describe, expect, it, vi } from 'vitest';
import type { OutboxItem } from '../db/store';
import { MAX_UNAUTHORIZED, createOutboxRunner, flushOutbox, type FlushDeps } from './flush';

const item = (id: string, state: OutboxItem['state'] = 'queued'): OutboxItem => ({
  clientMsgId: id,
  conversationId: 'c',
  body: id,
  replyToId: null,
  queuedAt: 0,
  state,
  error: null,
});

function setup(
  items: OutboxItem[],
  send: (i: OutboxItem) => Promise<Message>,
  generation: () => number = () => 1,
) {
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
    generation,
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
    for (const status of [500, 502, 429, 408, 401]) {
      const s = setup([item('a')], () => Promise.reject(new ApiError(status, 'x')));
      await expect(flushOutbox(s.deps)).resolves.toEqual({ sent: 0, stopped: true });
      expect(s.failed).toEqual({});
    }
  });

  it("stops when the account changes mid-run, so the old account's queue is never sent as the new one", async () => {
    let gen = 1;
    const send = vi.fn((i: OutboxItem) => {
      if (i.clientMsgId === 'a') gen = 2; // sign-out, then another sign-in, while 'a' was in flight
      return ok(i);
    });
    const s = setup([item('a'), item('b'), item('c')], send, () => gen);
    await expect(flushOutbox(s.deps)).resolves.toEqual({ sent: 1, stopped: true });
    expect(send).toHaveBeenCalledTimes(1); // b and c were never sent
  });

  it('hands onSent the generation the run started under', async () => {
    const seen: number[] = [];
    const s = setup([item('a')], ok, () => 7);
    s.deps.onSent = (_i, _m, generation) => {
      seen.push(generation);
    };
    await flushOutbox(s.deps);
    expect(seen).toEqual([7]);
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

describe('flushOutbox 401 handling', () => {
  const unauthorized = () => Promise.reject(new ApiError(401, 'unauthorized', 'No'));

  it('retries a 401 later, then marks the message failed after repeated 401s', async () => {
    const s = setup([item('a'), item('b')], unauthorized);
    const counts = new Map<string, number>();
    const deps = { ...s.deps, unauthorized: counts };
    for (let n = 1; n < MAX_UNAUTHORIZED; n++) {
      await expect(flushOutbox(deps)).resolves.toEqual({ sent: 0, stopped: true });
      expect(s.failed).toEqual({});
    }
    s.deps.send = ok;
    deps.send = (i) => (i.clientMsgId === 'a' ? unauthorized() : ok(i));
    await flushOutbox(deps);
    expect(Object.keys(s.failed)).toEqual(['a']);
    expect(s.sentOrder).toEqual(['b']);
  });

  it('forgets earlier 401s once the message goes through', async () => {
    const s = setup([item('a')], unauthorized);
    const counts = new Map<string, number>();
    await flushOutbox({ ...s.deps, unauthorized: counts });
    expect(counts.get('a')).toBe(1);
    await flushOutbox({ ...s.deps, send: ok, unauthorized: counts });
    expect(counts.has('a')).toBe(false);
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

  it('a second pass never runs under a newer account than the run started under', async () => {
    let gen = 1;
    const s = setup([item('a')], ok, () => gen);
    const runner = createOutboxRunner(s.deps);
    const first = runner.flush();
    // asked for again while running, then the account changes before the second pass starts
    void runner.flush();
    s.queue.push(item('b'));
    gen = 2;
    await first;
    expect(s.sentOrder).not.toContain('b');
  });

  it('starts a fresh run for the new account after a previous-generation run ends', async () => {
    let gen = 1;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(
      [item('a')],
      async (i) => {
        await gate;
        return ok(i);
      },
      () => gen,
    );
    const runner = createOutboxRunner(s.deps);
    const old = runner.flush();
    gen = 2;
    s.queue.push(item('n'));
    const fresh = runner.flush();
    release();
    await old;
    await fresh;
    expect(s.sentOrder).toContain('n');
  });
});
