import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { makeEnvelope, type Me, type UpdateSettingsInput } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { AuthService } from '../auth/auth.service.js';
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
   * immediately rather than within 30 days: leaves every conversation (handing a group's admin
   * role on as leaving normally does), erases their messages, files and profile, ends every
   * session. The row itself stays as an anonymous "Deleted user" so others' history holds up.
   */
  async deleteAccount(userId: string, password: string): Promise<void> {
    if (!(await this.auth.verifyPasswordFor(userId, password))) {
      throw new BadRequestException('Your password is incorrect');
    }
    const user = await findUserById(this.db, userId);
    if (!user) throw new NotFoundException('User not found');
    for (const conversationId of await listActiveConversationIds(this.db, userId)) {
      await leaveConversation(this.db, conversationId, userId);
    }
    const files = await eraseAccount(this.db, userId);
    await this.attachments.deleteFiles(files);
    if (user.avatarKey) {
      await this.s3
        .deleteObjects([`${user.avatarKey}/64.webp`, `${user.avatarKey}/256.webp`])
        .catch(() => undefined);
    }
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
