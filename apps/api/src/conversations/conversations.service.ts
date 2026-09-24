import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConversationSummary } from '@videochat/shared';
import type { Database } from '../db/client.js';
import { DB } from '../infra/tokens.js';
import {
  findConversationForUser,
  findOrCreateDirectConversation,
  listConversationsForUser,
} from '../db/conversations.js';
import { findUserById } from '../db/users.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { S3Service } from '../storage/s3.service.js';
import { toConversationSummary } from './conversation-mapper.js';

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly s3: S3Service,
    private readonly realtime: RealtimeService,
  ) {}

  async startDirect(userId: string, otherUserId: string): Promise<ConversationSummary> {
    if (userId === otherUserId) {
      throw new BadRequestException("Can't start a conversation with yourself");
    }
    const other = await findUserById(this.db, otherUserId);
    if (!other) throw new NotFoundException('User not found');

    const conv = await findOrCreateDirectConversation(this.db, userId, otherUserId);
    // Whether this just created the conversation or found an existing one, make sure both
    // members' already-open sockets (if any) are registered for it -- otherwise a socket that
    // connected before this conversation existed would never hear the first message sent into
    // it (see RealtimeService.addConversationForUser).
    this.realtime.addConversationForUser(userId, conv.id);
    this.realtime.addConversationForUser(otherUserId, conv.id);
    const avatarUrl = await this.s3.getAvatarUrl(other.avatarKey);
    return toConversationSummary({ ...conv, peer: other }, avatarUrl);
  }

  /** CHAT-014: a single conversation, for a client that navigated straight to it (e.g. a
   *  reload) without the full list already in cache. 404s for a non-member, same as the
   *  message endpoints. */
  async getById(conversationId: string, userId: string): Promise<ConversationSummary> {
    const row = await findConversationForUser(this.db, conversationId, userId);
    if (!row) throw new NotFoundException('Conversation not found');
    const avatarUrl = row.peer ? await this.s3.getAvatarUrl(row.peer.avatarKey) : null;
    return toConversationSummary(row, avatarUrl);
  }

  async listForUser(userId: string): Promise<ConversationSummary[]> {
    const rows = await listConversationsForUser(this.db, userId);
    return Promise.all(
      rows.map(async (row) => {
        const avatarUrl = row.peer ? await this.s3.getAvatarUrl(row.peer.avatarKey) : null;
        return toConversationSummary(row, avatarUrl);
      }),
    );
  }
}
