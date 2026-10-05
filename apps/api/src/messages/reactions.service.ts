import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LIMITS, makeEnvelope, type MessageReactions } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { hasBlockInDirectConversation } from '../db/blocks.js';
import { isConversationMember } from '../db/conversations.js';
import { lockMessage } from '../db/messages.js';
import { listReactions, toggleReaction } from '../db/reactions.js';
import { DB } from '../infra/tokens.js';
import { RealtimeService } from '../realtime/realtime.service.js';

/**
 * CHAT-033: emoji reactions. Toggling is idempotent per (message, person, emoji): reacting twice
 * with the same emoji removes it. Every change goes out to the conversation as
 * `message.reactions` with the message's full, regrouped set -- small, and immune to ordering
 * races between two people reacting at once. A block in a direct conversation (either direction)
 * stops reactions there, like it stops messages.
 */
@Injectable()
export class ReactionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
  ) {}

  async toggle(
    conversationId: string,
    userId: string,
    messageId: string,
    emoji: string,
  ): Promise<MessageReactions> {
    if (!(await isConversationMember(this.db, conversationId, userId))) {
      throw new NotFoundException('Conversation not found');
    }
    if (await hasBlockInDirectConversation(this.db, conversationId, userId)) {
      throw new ForbiddenException('You can’t react in this conversation');
    }
    // One transaction holding the message's row lock: the deleted check and the distinct-emoji
    // cap can't be raced by a concurrent delete or another new emoji.
    const result = await this.db.transaction(async (tx) => {
      const message = await lockMessage(tx, messageId);
      if (!message || message.conversationId !== conversationId) {
        throw new NotFoundException('Message not found');
      }
      if (message.deletedAt || message.type === 'system') {
        throw new BadRequestException('You can’t react to this message');
      }
      return toggleReaction(tx, messageId, userId, emoji, LIMITS.reactionsPerMessageMax);
    });
    if (result === 'limit') {
      throw new BadRequestException(
        `A message can have at most ${LIMITS.reactionsPerMessageMax} different reactions`,
      );
    }
    const payload: MessageReactions = {
      conversationId,
      messageId,
      reactions: (await listReactions(this.db, [messageId])).get(messageId) ?? [],
    };
    await this.realtime.publishToConversation(
      conversationId,
      makeEnvelope('message.reactions', payload, randomUUID()),
    );
    return payload;
  }
}
