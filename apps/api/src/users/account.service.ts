import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { makeEnvelope, type Me, type UpdateSettingsInput } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { AuthService } from '../auth/auth.service.js';
import { TokenStateService } from '../auth/token-state.service.js';
import { appendMessage } from '../db/messages.js';
import { toMessage } from '../messages/message-mapper.js';
import {
  eraseAccount,
  listActiveConversationIds,
  listConversationsForExport,
  listMessagesSentBy,
  updateUserSettings,
} from '../db/account.js';
import type { Database } from '../db/client.js';
import { leaveConversation } from '../db/conversations.js';
import { findUserById } from '../db/users.js';
import { DB } from '../infra/tokens.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { S3Service } from '../storage/s3.service.js';
import { toMe } from './user-mapper.js';

/** CHAT-037: settings, data export and account deletion. */
@Injectable()
export class AccountService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly s3: S3Service,
    private readonly realtime: RealtimeService,
    private readonly auth: AuthService,
    private readonly attachments: AttachmentsService,
    private readonly tokenState: TokenStateService,
  ) {}

  /** AC "changes save immediately and apply on all devices": the new settings go to every one
   *  of the person's connected devices as `me.updated`. */
  async updateSettings(userId: string, input: UpdateSettingsInput): Promise<Me> {
    const user = await updateUserSettings(this.db, userId, input);
    const me = toMe(user, await this.s3.getAvatarUrl(user.avatarKey));
    await this.realtime.publishToUser(userId, makeEnvelope('me.updated', me, randomUUID()));
    return me;
  }

  /**
   * AC: "delete account asks for the password and removes personal data within 30 days". Done
   * immediately. Leaving every conversation (handing a group's admin role on, as leaving
   * normally does) and erasing their messages, files and profile happen in one transaction --
   * all or nothing. Only once that's committed: stored files are deleted, every open connection
   * of theirs is closed on every node (so a still-open tab stops receiving anything), and the
   * conversations they left are told.
   */
  async deleteAccount(userId: string, password: string): Promise<void> {
    if (!(await this.auth.verifyPasswordFor(userId, password))) {
      throw new BadRequestException('Your password is incorrect');
    }
    const user = await findUserById(this.db, userId);
    if (!user) throw new NotFoundException('User not found');

    const left: Array<{ conversationId: string; promotedUserId: string | null }> = [];
    const files = await this.db.transaction(async (tx) => {
      for (const conversationId of await listActiveConversationIds(tx, userId)) {
        // leaveConversation opens its own (nested -> savepoint) transaction.
        const result = await leaveConversation(tx as unknown as Database, conversationId, userId);
        if (result.left) left.push({ conversationId, promotedUserId: result.promotedUserId });
      }
      return eraseAccount(tx, userId);
    });

    this.tokenState.invalidate(userId);
    await this.realtime.closeUserConnections(userId, 'account-deleted');
    for (const { conversationId } of left) {
      this.realtime.removeConversationForUser(userId, conversationId);
    }
    await this.attachments.deleteFiles(files);
    if (user.avatarKey) {
      await this.s3
        .deleteObjects([`${user.avatarKey}/64.webp`, `${user.avatarKey}/256.webp`])
        .catch(() => undefined);
    }
    // Not their name: the notice outlives the account, and the point is that it's erased.
    for (const { conversationId, promotedUserId } of left) {
      await this.postSystemMessage(conversationId, 'A member deleted their account');
      if (promotedUserId) {
        const promoted = await findUserById(this.db, promotedUserId);
        if (promoted)
          await this.postSystemMessage(conversationId, `${promoted.displayName} is now an admin`);
      }
    }
  }

  private async postSystemMessage(conversationId: string, body: string): Promise<void> {
    const row = await appendMessage(this.db, {
      conversationId,
      senderId: null,
      body,
      type: 'system',
    });
    const message = toMessage(row);
    await this.realtime.publishToConversation(
      conversationId,
      makeEnvelope('message.new', message, message.id),
    );
  }

  /** AC: "data export produces a JSON archive of the user's messages" (plus their profile,
   *  settings and conversations, so the messages make sense on their own). */
  async exportData(userId: string) {
    const user = await findUserById(this.db, userId);
    if (!user) throw new NotFoundException('User not found');
    const [conversations, messages] = await Promise.all([
      listConversationsForExport(this.db, userId),
      listMessagesSentBy(this.db, userId),
    ]);
    const me = toMe(user, null);
    return {
      exportedAt: new Date().toISOString(),
      profile: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        createdAt: user.createdAt.toISOString(),
      },
      settings: me.settings,
      conversations: conversations.map((c) => ({
        id: c.id,
        type: c.type,
        title: c.title,
        joinedAt: new Date(c.joined_at).toISOString(),
        otherMembers: c.members,
      })),
      messages: messages.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt ? m.editedAt.toISOString() : null,
      })),
    };
  }
}
