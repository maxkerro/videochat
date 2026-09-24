import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConversationSummary } from '@videochat/shared';
import type { Database } from '../db/client.js';
import { DB } from '../infra/tokens.js';
import { findOrCreateDirectConversation, listConversationsForUser } from '../db/conversations.js';
import { findUserById } from '../db/users.js';
import { S3Service } from '../storage/s3.service.js';
import { toConversationSummary } from './conversation-mapper.js';

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly s3: S3Service,
  ) {}

  async startDirect(userId: string, otherUserId: string): Promise<ConversationSummary> {
    if (userId === otherUserId) {
      throw new BadRequestException("Can't start a conversation with yourself");
    }
    const other = await findUserById(this.db, otherUserId);
    if (!other) throw new NotFoundException('User not found');

    const conv = await findOrCreateDirectConversation(this.db, userId, otherUserId);
    const avatarUrl = await this.s3.getAvatarUrl(other.avatarKey);
    return toConversationSummary({ ...conv, peer: other }, avatarUrl);
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
