import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Database } from '../db/client.js';
import * as blocksDb from '../db/blocks.js';
import * as attachmentsDb from '../db/attachments.js';
import * as conversationsDb from '../db/conversations.js';
import * as reactionsDb from '../db/reactions.js';
import * as messagesDb from '../db/messages.js';
import { SenderNotAMemberError } from '../db/messages.js';
import type { AttachmentsService } from '../attachments/attachments.service.js';
import type { LinkPreviewsService } from '../link-previews/link-previews.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import { MessagesService } from './messages.service.js';

vi.mock('../db/blocks.js', () => ({ isSenderBlockedInDirectConversation: vi.fn() }));
vi.mock('../db/conversations.js', () => ({
  isConversationMember: vi.fn(),
  findConversationForUser: vi.fn(),
}));
vi.mock('../db/attachments.js', () => ({ findAttachmentsForMessage: vi.fn() }));
vi.mock('../db/reactions.js', () => ({
  listReactions: vi.fn(),
  deleteReactionsForMessage: vi.fn(),
}));
vi.mock('../db/messages.js', async () => {
  const actual = await vi.importActual<typeof import('../db/messages.js')>('../db/messages.js');
  return {
    appendMessage: vi.fn(),
    appendMessageWithStatus: vi.fn(),
    findMessage: vi.fn(),
    findMessagesByIds: vi.fn(),
    editMessageBody: vi.fn(),
    softDeleteMessage: vi.fn(),
    listMessagesPage: vi.fn(),
    listMessagesAfter: vi.fn(),
    SenderNotAMemberError: actual.SenderNotAMemberError,
    ClientMsgIdConflictError: actual.ClientMsgIdConflictError,
  };
});

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
    meta: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('MessagesService', () => {
  let realtime: { publishToConversation: ReturnType<typeof vi.fn> };
  let service: MessagesService;
  let linkPreviews: { attachToMessage: ReturnType<typeof vi.fn> };
  let attachments: {
    prepareForMessage: ReturnType<typeof vi.fn>;
    linkToMessage: ReturnType<typeof vi.fn>;
    deleteRows: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    attachments = {
      prepareForMessage: vi.fn(),
      linkToMessage: vi.fn().mockResolvedValue(undefined),
      deleteRows: vi.fn().mockResolvedValue(undefined),
    };
    linkPreviews = { attachToMessage: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(messagesDb.findMessagesByIds).mockResolvedValue([]);
    vi.mocked(reactionsDb.listReactions).mockResolvedValue(new Map());
    // The service uses appendMessageWithStatus; tests stub appendMessage's result and assert on it.
    vi.mocked(messagesDb.appendMessageWithStatus).mockImplementation(async (db, input) => ({
      row: await messagesDb.appendMessage(db, input),
      created: true,
    }));
    realtime = { publishToConversation: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(blocksDb.isSenderBlockedInDirectConversation).mockResolvedValue(false);
    service = new MessagesService(
      {} as Database,
      realtime as unknown as RealtimeService,
      attachments as unknown as AttachmentsService,
      linkPreviews as unknown as LinkPreviewsService,
      { notifyNewMessage: vi.fn().mockResolvedValue(undefined) } as unknown as NotificationsService,
    );
  });

  describe('send', () => {
    it('CHAT-031: asks for a link preview after a new text message, unless turned off', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(messagesDb.appendMessage).mockResolvedValue(makeMessageRow());
      await service.send('conv-1', 'user-1', { clientMsgId: 'c-1', body: 'see https://a.dev' });
      expect(linkPreviews.attachToMessage).toHaveBeenCalledTimes(1);
      await service.send('conv-1', 'user-1', {
        clientMsgId: 'c-2',
        body: 'see https://a.dev',
        linkPreview: false,
      });
      expect(linkPreviews.attachToMessage).toHaveBeenCalledTimes(1);
    });

    it('CHAT-031: does not fetch again for a retried send', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(messagesDb.appendMessageWithStatus).mockResolvedValue({
        row: makeMessageRow() as never,
        created: false,
      });
      await service.send('conv-1', 'user-1', { clientMsgId: 'c-1', body: 'https://a.dev' });
      expect(linkPreviews.attachToMessage).not.toHaveBeenCalled();
    });

    it('CHAT-030: sends a prepared attachment as an image message and links it', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      const attachment = {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'image' as const,
        filename: 'cat.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1234,
        width: 640,
        height: 480,
      };
      attachments.prepareForMessage.mockResolvedValue(attachment);
      vi.mocked(messagesDb.appendMessage).mockResolvedValue(
        makeMessageRow({ type: 'image', body: null, meta: { attachment } }),
      );

      const message = await service.send('conv-1', 'user-1', {
        clientMsgId: 'c-1',
        attachmentId: attachment.id,
      });

      expect(attachments.prepareForMessage).toHaveBeenCalledWith('user-1', 'conv-1', attachment.id);
      expect(messagesDb.appendMessage).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ type: 'image', body: null, meta: { attachment } }),
      );
      expect(attachments.linkToMessage).toHaveBeenCalledWith(attachment.id, message.id);
      expect(message.attachment).toEqual(attachment);
    });

    it("CHAT-030: doesn't create a message when the attachment can't be prepared", async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      attachments.prepareForMessage.mockRejectedValue(new Error('not uploaded'));
      await expect(
        service.send('conv-1', 'user-1', { clientMsgId: 'c-1', attachmentId: 'a' }),
      ).rejects.toThrow('not uploaded');
      expect(messagesDb.appendMessage).not.toHaveBeenCalled();
    });

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

    it('rejects with 409 when clientMsgId was already used in a different conversation, without broadcasting', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      // appendMessage dedupes on (senderId, clientMsgId) alone, and refuses a match that belongs
      // to some *other* conversation than the one this call is targeting.
      vi.mocked(messagesDb.appendMessage).mockRejectedValue(
        new messagesDb.ClientMsgIdConflictError('c-1'),
      );

      await expect(
        service.send('conv-1', 'user-1', { clientMsgId: 'c-1', body: 'hi' }),
      ).rejects.toThrow(ConflictException);
      expect(realtime.publishToConversation).not.toHaveBeenCalled();
    });

    it('CHAT-018: rejects with 404 (not the raw error) when appendMessage finds the sender was removed inside its own transaction', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(messagesDb.appendMessage).mockRejectedValue(new SenderNotAMemberError('conv-1'));

      await expect(
        service.send('conv-1', 'user-1', { clientMsgId: 'c-1', body: 'hi' }),
      ).rejects.toThrow(NotFoundException);
      expect(realtime.publishToConversation).not.toHaveBeenCalled();
    });

    it('CHAT-021: rejects with 403 when the DM recipient has blocked the sender, without persisting or broadcasting', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(blocksDb.isSenderBlockedInDirectConversation).mockResolvedValue(true);

      await expect(
        service.send('conv-1', 'user-1', { clientMsgId: 'c-1', body: 'hi' }),
      ).rejects.toThrow(ForbiddenException);
      expect(messagesDb.appendMessage).not.toHaveBeenCalled();
      expect(realtime.publishToConversation).not.toHaveBeenCalled();
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

  describe('listPage', () => {
    it('rejects a non-member with 404', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(false);
      await expect(service.listPage('conv-1', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('returns messages oldest first, mapped to the API shape, with hasMore passed through', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(messagesDb.listMessagesPage).mockResolvedValue({
        rows: [
          makeMessageRow({ seq: 1, id: 'a'.repeat(26) }),
          makeMessageRow({ seq: 2, id: 'b'.repeat(26) }),
        ],
        hasMore: true,
      });

      const result = await service.listPage('conv-1', 'user-1');

      expect(result.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(result.messages[0]!.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(result.hasMore).toBe(true);
      expect(messagesDb.listMessagesPage).toHaveBeenCalledWith(
        {},
        'conv-1',
        expect.objectContaining({ beforeSeq: undefined }),
      );
    });

    it('forwards a `beforeSeq` cursor to the DB layer', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(messagesDb.listMessagesPage).mockResolvedValue({ rows: [], hasMore: false });

      await service.listPage('conv-1', 'user-1', 42);

      expect(messagesDb.listMessagesPage).toHaveBeenCalledWith(
        {},
        'conv-1',
        expect.objectContaining({ beforeSeq: 42 }),
      );
    });
  });

  describe('listAfter', () => {
    it('rejects a non-member with 404', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(false);
      await expect(service.listAfter('conv-1', 'user-1', 5)).rejects.toThrow(NotFoundException);
    });

    it('returns messages ascending, mapped to the API shape, with hasMore passed through', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(messagesDb.listMessagesAfter).mockResolvedValue({
        rows: [
          makeMessageRow({ seq: 3, id: 'a'.repeat(26) }),
          makeMessageRow({ seq: 4, id: 'b'.repeat(26) }),
        ],
        hasMore: true,
      });

      const result = await service.listAfter('conv-1', 'user-1', 2);

      expect(result.messages.map((m) => m.seq)).toEqual([3, 4]);
      expect(result.hasMore).toBe(true);
      expect(messagesDb.listMessagesAfter).toHaveBeenCalledWith(
        {},
        'conv-1',
        expect.objectContaining({ afterSeq: 2 }),
      );
    });
  });

  describe('CHAT-032 edit and delete', () => {
    const mine = () =>
      makeMessageRow({ senderId: 'user-1', createdAt: new Date(), body: 'original' });

    beforeEach(() => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
      vi.mocked(attachmentsDb.findAttachmentsForMessage).mockResolvedValue([]);
    });

    it('edits within the window, announces it, and re-checks the link preview', async () => {
      vi.mocked(messagesDb.findMessage).mockResolvedValue(mine() as never);
      vi.mocked(messagesDb.editMessageBody).mockResolvedValue(
        makeMessageRow({ senderId: 'user-1', body: 'fixed', editedAt: new Date() }) as never,
      );
      const message = await service.edit('conv-1', 'user-1', 'm', 'fixed');
      expect(message).toMatchObject({ body: 'fixed' });
      expect(message.editedAt).not.toBeNull();
      const [, envelope] = realtime.publishToConversation.mock.calls[0]!;
      expect(envelope).toMatchObject({ type: 'message.updated', payload: { body: 'fixed' } });
      expect(linkPreviews.attachToMessage).toHaveBeenCalled();
    });

    it("refuses editing someone else's message, a call entry, or after 15 minutes", async () => {
      vi.mocked(messagesDb.findMessage).mockResolvedValue(
        makeMessageRow({ senderId: 'user-2', createdAt: new Date() }) as never,
      );
      await expect(service.edit('conv-1', 'user-1', 'm', 'x')).rejects.toThrow(ForbiddenException);
      vi.mocked(messagesDb.findMessage).mockResolvedValue(
        makeMessageRow({ senderId: 'user-1', type: 'call', createdAt: new Date() }) as never,
      );
      await expect(service.edit('conv-1', 'user-1', 'm', 'x')).rejects.toThrow(/can’t be edited/);
      vi.mocked(messagesDb.findMessage).mockResolvedValue(
        makeMessageRow({
          senderId: 'user-1',
          createdAt: new Date(Date.now() - 16 * 60_000),
        }) as never,
      );
      await expect(service.edit('conv-1', 'user-1', 'm', 'x')).rejects.toThrow(/15 minutes/);
      expect(messagesDb.editMessageBody).not.toHaveBeenCalled();
    });

    it('404s a message from another conversation', async () => {
      vi.mocked(messagesDb.findMessage).mockResolvedValue(
        makeMessageRow({ conversationId: 'conv-other' }) as never,
      );
      await expect(service.edit('conv-1', 'user-1', 'm', 'x')).rejects.toThrow(NotFoundException);
      await expect(service.delete('conv-1', 'user-1', 'm')).rejects.toThrow(NotFoundException);
    });

    it('deletes for the sender: wipes content, removes attachment files, announces it', async () => {
      vi.mocked(messagesDb.findMessage).mockResolvedValue(mine() as never);
      vi.mocked(messagesDb.softDeleteMessage).mockResolvedValue(
        makeMessageRow({ senderId: 'user-1', body: null, deletedAt: new Date() }) as never,
      );
      vi.mocked(attachmentsDb.findAttachmentsForMessage).mockResolvedValue([{ id: 'a' }] as never);
      const tombstone = await service.delete('conv-1', 'user-1', 'm');
      expect(tombstone).toMatchObject({ body: null });
      expect(tombstone.deletedAt).not.toBeNull();
      expect(attachments.deleteRows).toHaveBeenCalledWith([{ id: 'a' }]);
      expect(reactionsDb.deleteReactionsForMessage).toHaveBeenCalledWith({}, 'm');
      expect(realtime.publishToConversation).toHaveBeenCalled();
    });

    it("lets a group admin delete someone else's message, but not a plain member", async () => {
      vi.mocked(messagesDb.findMessage).mockResolvedValue(
        makeMessageRow({ senderId: 'user-2' }) as never,
      );
      vi.mocked(messagesDb.softDeleteMessage).mockResolvedValue(
        makeMessageRow({ senderId: 'user-2', body: null, deletedAt: new Date() }) as never,
      );
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue({
        type: 'group',
        role: 'member',
      } as never);
      await expect(service.delete('conv-1', 'user-1', 'm')).rejects.toThrow(ForbiddenException);
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue({
        type: 'direct',
        role: 'admin',
      } as never);
      await expect(service.delete('conv-1', 'user-1', 'm')).rejects.toThrow(ForbiddenException);
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue({
        type: 'group',
        role: 'admin',
      } as never);
      await expect(service.delete('conv-1', 'user-1', 'm')).resolves.toMatchObject({ body: null });
    });

    it('rejects a reply to a message in another conversation or a deleted one', async () => {
      vi.mocked(messagesDb.findMessage).mockResolvedValue(
        makeMessageRow({ conversationId: 'conv-other' }) as never,
      );
      await expect(
        service.send('conv-1', 'user-1', {
          clientMsgId: 'c',
          body: 'hi',
          replyToId: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
        }),
      ).rejects.toThrow(/no longer available/);
      vi.mocked(messagesDb.findMessage).mockResolvedValue(
        makeMessageRow({ deletedAt: new Date() }) as never,
      );
      await expect(
        service.send('conv-1', 'user-1', {
          clientMsgId: 'c',
          body: 'hi',
          replyToId: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
        }),
      ).rejects.toThrow(/no longer available/);
    });
  });
});
