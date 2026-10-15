import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@videochat/shared';
import { loadUntilLoaded } from './jump';
import type { MessagesState } from './messagesState';

const msg = (id: string, seq: number) => ({ id, seq }) as Message;

describe('loadUntilLoaded (CHAT-072)', () => {
  it('loads older pages until the message is in', async () => {
    let state: MessagesState = { messages: [msg('d', 4)], hasMore: true };
    const pages = [[msg('c', 3)], [msg('a', 1), msg('b', 2)]];
    const loadOlder = vi.fn(async () => {
      const page = pages.shift()!;
      state = { messages: [...page, ...state.messages], hasMore: pages.length > 0 };
      return true;
    });
    await expect(loadUntilLoaded('a', () => state, loadOlder)).resolves.toBe(true);
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it('does not load anything when the message is already there', async () => {
    const loadOlder = vi.fn(async () => true);
    const state = { messages: [msg('a', 1)], hasMore: true };
    await expect(loadUntilLoaded('a', () => state, loadOlder)).resolves.toBe(true);
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it('gives up at the start of history, when a page fails, or after the page limit', async () => {
    const atStart = { messages: [msg('b', 2)], hasMore: false };
    await expect(
      loadUntilLoaded(
        'a',
        () => atStart,
        async () => true,
      ),
    ).resolves.toBe(false);

    const more = { messages: [msg('b', 2)], hasMore: true };
    const failing = vi.fn(async () => false);
    await expect(loadUntilLoaded('a', () => more, failing)).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);

    const endless = vi.fn(async () => true);
    await expect(loadUntilLoaded('a', () => more, endless, 3)).resolves.toBe(false);
    expect(endless).toHaveBeenCalledTimes(3);
  });
});
