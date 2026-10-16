import type { Message } from '@videochat/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { DecryptResult, E2eeClient } from './client';
import { ENCRYPTED_PLACEHOLDER, useDecryptedMessages } from './index';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn(), withAuthRetry: vi.fn() }));

const base: Message = {
  id: '01J0000000000000000000000A',
  conversationId: '33333333-3333-4333-8333-333333333333',
  seq: 1,
  senderId: null,
  clientMsgId: null,
  type: 'text',
  body: null,
  replyToId: null,
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-10-16T10:00:00.000Z',
};
const encrypted = { ...base, e2ee: { v: 1 as const, ciphertext: 'AAAA' } };
const plain = { ...base, id: '01J0000000000000000000000B', seq: 2, body: 'plain text' };

describe('useDecryptedMessages (CHAT-076 spike)', () => {
  it('shows a placeholder when this browser has the prototype off', () => {
    const { result } = renderHook(() => useDecryptedMessages(null, [encrypted, plain]));
    expect(result.current.map((m) => m.body)).toEqual([ENCRYPTED_PLACEHOLDER, 'plain text']);
  });

  it('swaps in the decrypted text, decrypting each message once', async () => {
    const decrypt = vi.fn(async (): Promise<DecryptResult> => ({
      status: 'ok',
      text: 'secret hi',
    }));
    const client = { decrypt } as unknown as E2eeClient;
    const messages = [encrypted, plain];
    const { result, rerender } = renderHook(({ list }) => useDecryptedMessages(client, list), {
      initialProps: { list: messages },
    });
    await waitFor(() => expect(result.current[0]!.body).toBe('secret hi'));
    expect(result.current[1]!.body).toBe('plain text');
    rerender({ list: [...messages] });
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('asks again while the keys are still on their way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const decrypt = vi
        .fn<() => Promise<DecryptResult>>()
        .mockResolvedValueOnce({ status: 'waiting' })
        .mockResolvedValue({ status: 'ok', text: 'arrived' });
      const client = { decrypt } as unknown as E2eeClient;
      const list = [encrypted];
      const { result } = renderHook(() => useDecryptedMessages(client, list));
      await waitFor(() => expect(result.current[0]!.body).toMatch(/Waiting/));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      await waitFor(() => expect(result.current[0]!.body).toBe('arrived'));
      expect(decrypt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
