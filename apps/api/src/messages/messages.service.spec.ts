import { NotFoundException } from '@nestjs/common';
import type { Database } from '../db/client.js';
import * as conversationsDb from '../db/conversations.js';
import * as messagesDb from '../db/messages.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import { MessagesService } from './messages.service.js';

vi.mock('../db/conversations.js', () => ({ isConversationMember: vi.fn() }));
vi.mock('../db/messages.js', () => ({ appendMessage: vi.fn(), listRecentMessages: vi.fn() }));

function makeMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
    conversationId: 'conv-1',
    seq: 1,
    senderId: 'user-1',
    clientMsgId: 'c-1',
    type: 'text' as const,
    body: 'hello',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('MessagesService', () => {
  let realtime: { publishToConversation: ReturnType<typeof vi.fn> };
  let service: MessagesService;

  beforeEach(() => {
    vi.resetAllMocks();
    realtime = { publishToConversation: vi.fn().mockResolvedValue(undefined) };
    service = new MessagesService({} as Database, realtime as unknown as RealtimeService);
  });

  describe('send', () => {
    it('rejects a non-member with 404, without persisting or broadcasting', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(false);

      await expect(
        service.send('conv-1', 'user-1', { clientMsgId: 'c-1', body: 'hi' }),
      ).rejects.toThrow(NotFoundException);
      expect(messagesDb.appendMessage).not.toHaveBeenCalled();
      expect(realtime.publishToConversation).not.toHaveBeenCalled();
    });

    it('persists the message and broadcasts it to the conversation', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(messagesDb.appendMessage).mockResolvedValue(makeMessageRow());

      const message = await service.send('conv-1', 'user-1', { clientMsgId: 'c-1', body: 'hi' });

      expect(message).toMatchObject({ id: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ', body: 'hello', seq: 1 });
      expect(messagesDb.appendMessage).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          conversationId: 'conv-1',
          senderId: 'user-1',
          clientMsgId: 'c-1',
        }),
      );
      expect(realtime.publishToConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({ type: 'message.new', payload: message }),
      );
    });

    it('retrying the same clientMsgId re-broadcasts the same message rather than a new one', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      const row = makeMessageRow();
      vi.mocked(messagesDb.appendMessage).mockResolvedValue(row);

      const first = await service.send('conv-1', 'user-1', { clientMsgId: 'c-1', body: 'hi' });
      const retry = await service.send('conv-1', 'user-1', { clientMsgId: 'c-1', body: 'hi' });

      expect(retry).toEqual(first);
      expect(realtime.publishToConversation).toHaveBeenCalledTimes(2);
    });
  });

  describe('listRecent', () => {
    it('rejects a non-member with 404', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(false);
      await expect(service.listRecent('conv-1', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('returns messages oldest first, mapped to the API shape', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(messagesDb.listRecentMessages).mockResolvedValue([
        makeMessageRow({ seq: 1, id: 'a'.repeat(26) }),
        makeMessageRow({ seq: 2, id: 'b'.repeat(26) }),
      ]);

      const result = await service.listRecent('conv-1', 'user-1');

      expect(result.map((m) => m.seq)).toEqual([1, 2]);
      expect(result[0]!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });
});
