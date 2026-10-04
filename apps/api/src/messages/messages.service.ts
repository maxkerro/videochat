import {
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
import type { Database } from '../db/client.js';
import { isSenderBlockedInDirectConversation } from '../db/blocks.js';
import { isConversationMember } from '../db/conversations.js';
import {
  appendMessage,
  listMessagesAfter,
  listMessagesPage,
  ClientMsgIdConflictError,
  SenderNotAMemberError,
} from '../db/messages.js';
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

    let row;
    try {
      row = await appendMessage(this.db, {
        conversationId,
        senderId,
        body: input.body,
        clientMsgId: input.clientMsgId,
      });
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
