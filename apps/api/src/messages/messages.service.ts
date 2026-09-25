import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  LIMITS,
  makeEnvelope,
  type Message,
  type MessagePage,
  type SendMessageInput,
} from '@videochat/shared';
import type { Database } from '../db/client.js';
import { isConversationMember } from '../db/conversations.js';
import { appendMessage, listMessagesAfter, listMessagesPage } from '../db/messages.js';
import { DB } from '../infra/tokens.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { toMessage } from './message-mapper.js';

@Injectable()
export class MessagesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * CHAT-014: persists the message (idempotently on `clientMsgId`, so a retried send never
   * duplicates), then broadcasts it to every member of the conversation over the realtime
   * gateway, on whichever node they're connected to. The HTTP response is the "ack" a client
   * is waiting on to move its optimistic message from "sending" to "sent".
   */
  async send(conversationId: string, senderId: string, input: SendMessageInput): Promise<Message> {
    // Checked here, outside appendMessage's own transaction: harmless today since there's no way
    // to leave or be removed from a (direct-only) conversation yet, but once group leave/kick
    // exists this has a real race -- someone removed between this check and the insert below
    // could still get one more message in. Re-check membership (with `leftAt IS NULL`) inside
    // appendMessage's transaction once that lands.
    await this.requireMember(conversationId, senderId);

    const row = await appendMessage(this.db, {
      conversationId,
      senderId,
      body: input.body,
      clientMsgId: input.clientMsgId,
    });
    // `appendMessage` dedupes on (senderId, clientMsgId) alone, with no conversation in the key.
    // If a client reuses a clientMsgId across two different conversations, the second call would
    // otherwise return -- and re-broadcast into this conversation -- a message that actually
    // belongs to the first one. Reject that rather than leaking it.
    if (row.conversationId !== conversationId) {
      throw new ConflictException('clientMsgId already used in another conversation');
    }
    const message = toMessage(row);

    // A retried send resolves to the same row every time; re-broadcasting it is harmless
    // (clients dedupe incoming messages by id) and simpler than tracking "already broadcast".
    await this.realtime.publishToConversation(
      conversationId,
      makeEnvelope('message.new', message, message.id),
    );
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
    return { messages: rows.map(toMessage), hasMore };
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
    return { messages: rows.map(toMessage), hasMore };
  }

  /** CHAT-022's "member-only access": a 404, not a 403, so a non-member can't tell a
   *  conversation id is even valid. */
  private async requireMember(conversationId: string, userId: string): Promise<void> {
    if (!(await isConversationMember(this.db, conversationId, userId))) {
      throw new NotFoundException('Conversation not found');
    }
  }
}
