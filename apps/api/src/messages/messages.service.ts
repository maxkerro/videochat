import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LIMITS,
  makeEnvelope,
  type Message,
  type MessagePage,
  type SendMessageInput,
} from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { isSenderBlockedInDirectConversation } from '../db/blocks.js';
import { findAttachmentsForMessage } from '../db/attachments.js';
import { deleteReactionsForMessage } from '../db/reactions.js';
import { findConversationForUser, isConversationMember } from '../db/conversations.js';
import {
  appendMessageWithStatus,
  editMessageBody,
  findMessage,
  listMessagesAfter,
  listMessagesPage,
  ClientMsgIdConflictError,
  SenderNotAMemberError,
  softDeleteMessage,
} from '../db/messages.js';
import type { MessageRow } from '../db/schema.js';
import { DB } from '../infra/tokens.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { LinkPreviewsService } from '../link-previews/link-previews.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { toMessageWithReply, toMessages } from './message-mapper.js';

/** CHAT-032: kinds of message a person can edit or delete. Call entries and system messages are
 *  everyone's record of what happened, so nobody can rewrite or remove them. */
const EDITABLE_TYPES = new Set<MessageRow['type']>(['text', 'image', 'file']);

@Injectable()
export class MessagesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
    private readonly attachments: AttachmentsService,
    private readonly linkPreviews: LinkPreviewsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * CHAT-014: persists the message (idempotently on `clientMsgId`, so a retried send never
   * duplicates), then broadcasts it to every member of the conversation over the realtime
   * gateway, on whichever node they're connected to. The HTTP response is the "ack" a client
   * is waiting on to move its optimistic message from "sending" to "sent".
   */
  async send(conversationId: string, senderId: string, input: SendMessageInput): Promise<Message> {
    // Fast-path only: rejects the common case (a plain non-member) with a 404 before opening a
    // transaction at all. This alone isn't race-proof -- CHAT-018 added group leave/kick, so
    // someone could be removed between this check and the insert below. `appendMessage` re-checks
    // membership (with `leftAt IS NULL`) *inside* its own transaction, which is the authoritative
    // check; `SenderNotAMemberError` below is that race actually firing.
    await this.requireMember(conversationId, senderId);

    // CHAT-021: "a blocked user's messages to you are rejected". Checked only for a *direct*
    // conversation -- see `isSenderBlockedInDirectConversation`'s own comment for why block
    // enforcement is scoped to DMs for this story: a group already has consenting multi-party
    // membership, and "who can be in this group with whom" is a separate concern (handled at
    // `addMembers`, not here) from "can this specific sender's message be delivered". This is
    // deliberately a visible failure to the *sender* -- a 403, not a silently-dropped message --
    // since the AC calls it "rejected", and a client needs some response to show the send as
    // failed rather than stuck "sending" forever. That's a different kind of silence than
    // "blocking is silent to the blocked person" (the *act* of blocking, covered by
    // `UsersService.blockUser`): this is about what happens on an already-blocked person's next
    // send, not about notifying them a block just happened.
    if (await isSenderBlockedInDirectConversation(this.db, conversationId, senderId)) {
      throw new ForbiddenException('This message could not be delivered');
    }

    // CHAT-032: a reply must point at a live message in this same conversation.
    if (input.replyToId) {
      const target = await findMessage(this.db, input.replyToId);
      if (!target || target.conversationId !== conversationId || target.deletedAt) {
        throw new BadRequestException('The message you replied to is no longer available');
      }
    }

    // CHAT-030: verify (and, for images, strip and thumbnail) the attachment before the message
    // exists, so nobody can ever download an unprocessed upload through it.
    const attachment = input.attachmentId
      ? await this.attachments.prepareForMessage(senderId, conversationId, input.attachmentId)
      : undefined;

    let row;
    let created: boolean;
    try {
      ({ row, created } = await appendMessageWithStatus(this.db, {
        conversationId,
        senderId,
        body: input.body ?? null,
        clientMsgId: input.clientMsgId,
        replyToId: input.replyToId ?? null,
        ...(attachment ? { type: attachment.kind, meta: { attachment } } : {}),
      }));
    } catch (err) {
      if (err instanceof SenderNotAMemberError) {
        throw new NotFoundException('Conversation not found');
      }
      // `appendMessage` dedupes on (senderId, clientMsgId) alone, with no conversation in the key.
      // A clientMsgId reused across conversations would otherwise return -- and re-broadcast into
      // this conversation -- a message that belongs to another one; it rejects that instead.
      if (err instanceof ClientMsgIdConflictError) {
        throw new ConflictException('clientMsgId already used in another conversation');
      }
      throw err;
    }
    if (attachment) await this.attachments.linkToMessage(attachment.id, row.id);
    const message = await toMessageWithReply(this.db, row);

    // A retried send resolves to the same row every time; re-broadcasting it is harmless
    // (clients dedupe incoming messages by id) and simpler than tracking "already broadcast".
    await this.realtime.publishToConversation(
      conversationId,
      makeEnvelope('message.new', message, message.id),
    );
    // CHAT-031: fetched after the message is out, so a slow site never delays it; arrives as a
    // `message.updated`. Only once per message (not again for a retried send).
    if (created && !attachment && input.linkPreview !== false) {
      void this.linkPreviews.attachToMessage(row);
    }
    // CHAT-035: push to members who aren't looking at this conversation (once per message).
    if (created) void this.notifications.notifyNewMessage(row);
    return message;
  }

  /** CHAT-016: a cursor-paged page of history, oldest first. `beforeSeq` omitted loads the most
   *  recent page; otherwise the page immediately before that `seq`. */
  async listPage(conversationId: string, userId: string, beforeSeq?: number): Promise<MessagePage> {
    await this.requireMember(conversationId, userId);
    const { rows, hasMore } = await listMessagesPage(this.db, conversationId, {
      beforeSeq,
      limit: LIMITS.messageHistoryPageSize,
    });
    return { messages: await toMessages(this.db, rows), hasMore };
  }

  /** CHAT-017: gap sync -- messages after `afterSeq`, ascending, for a client catching up after a
   *  reconnect. `hasMore: true` means the client should call again with the highest `seq` it just
   *  received, since more than one page was missed. */
  async listAfter(conversationId: string, userId: string, afterSeq: number): Promise<MessagePage> {
    await this.requireMember(conversationId, userId);
    const { rows, hasMore } = await listMessagesAfter(this.db, conversationId, {
      afterSeq,
      limit: LIMITS.messageGapSyncPageSize,
    });
    return { messages: await toMessages(this.db, rows), hasMore };
  }

  /**
   * CHAT-032: the sender edits their message's text within `LIMITS.messageEditWindowMinutes`.
   * Everyone in the conversation sees it change live (`message.updated`), marked edited.
   */
  async edit(
    conversationId: string,
    userId: string,
    messageId: string,
    body: string,
  ): Promise<Message> {
    const row = await this.requireMessage(conversationId, userId, messageId);
    if (row.senderId !== userId) throw new ForbiddenException('Only the sender can edit a message');
    if (!EDITABLE_TYPES.has(row.type))
      throw new BadRequestException('This message can’t be edited');
    if (row.deletedAt) throw new NotFoundException('Message not found');
    const windowMs = LIMITS.messageEditWindowMinutes * 60_000;
    if (Date.now() - row.createdAt.getTime() > windowMs) {
      throw new ForbiddenException(
        `Messages can only be edited for ${LIMITS.messageEditWindowMinutes} minutes`,
      );
    }
    if (row.body === body) return toMessageWithReply(this.db, row);
    const updated = await editMessageBody(this.db, messageId, body);
    if (!updated) throw new NotFoundException('Message not found');
    const message = await this.publishUpdated(updated);
    // The old text's link preview was dropped; the new text may have its own.
    if (updated.type === 'text') void this.linkPreviews.attachToMessage(updated);
    return message;
  }

  /**
   * CHAT-032: "delete for everyone" -- by the sender, or by a group admin. The content (text,
   * attachment and its stored files, link preview) is removed, leaving a "Message deleted"
   * tombstone in its place.
   */
  async delete(conversationId: string, userId: string, messageId: string): Promise<Message> {
    const row = await this.requireMessage(conversationId, userId, messageId);
    if (!EDITABLE_TYPES.has(row.type)) {
      throw new BadRequestException('This message can’t be deleted');
    }
    if (row.senderId !== userId) {
      const conversation = await findConversationForUser(this.db, conversationId, userId);
      const isGroupAdmin = conversation?.type === 'group' && conversation.role === 'admin';
      if (!isGroupAdmin) {
        throw new ForbiddenException('Only the sender or a group admin can delete a message');
      }
    }
    if (row.deletedAt) return toMessageWithReply(this.db, row);
    const deleted = await softDeleteMessage(this.db, messageId);
    if (!deleted) return toMessageWithReply(this.db, (await findMessage(this.db, messageId))!);
    await this.attachments.deleteRows(await findAttachmentsForMessage(this.db, messageId));
    await deleteReactionsForMessage(this.db, messageId);
    return this.publishUpdated(deleted);
  }

  private async publishUpdated(row: MessageRow): Promise<Message> {
    const message = await toMessageWithReply(this.db, row);
    await this.realtime.publishToConversation(
      row.conversationId,
      makeEnvelope('message.updated', message, randomUUID()),
    );
    return message;
  }

  private async requireMessage(
    conversationId: string,
    userId: string,
    messageId: string,
  ): Promise<MessageRow> {
    await this.requireMember(conversationId, userId);
    const row = await findMessage(this.db, messageId);
    if (!row || row.conversationId !== conversationId) {
      throw new NotFoundException('Message not found');
    }
    return row;
  }

  /** CHAT-022's "member-only access": a 404, not a 403, so a non-member can't tell a
   *  conversation id is even valid. */
  private async requireMember(conversationId: string, userId: string): Promise<void> {
    if (!(await isConversationMember(this.db, conversationId, userId))) {
      throw new NotFoundException('Conversation not found');
    }
  }
}
