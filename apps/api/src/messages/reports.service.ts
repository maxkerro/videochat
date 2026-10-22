import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ReportMessageInput, ReportUserInput } from '@videochat/shared';
import type { Database } from '../db/client.js';
import { isConversationMember, wasConversationMember } from '../db/conversations.js';
import { upsertMessageReport, upsertUserReport } from '../db/message-reports.js';
import { findMessage } from '../db/messages.js';
import { DB } from '../infra/tokens.js';

/**
 * CHAT-058: "report this message" -- the report mechanism the app stores require for user-generated
 * content. Any member can report someone else's message. The report keeps a copy of the text (the
 * sender may edit or delete it afterwards) and goes to the structured log so it can be alerted on.
 * CHAT-077: reports land in the moderation queue at once (`ModerationService`).
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  async report(
    conversationId: string,
    userId: string,
    messageId: string,
    input: ReportMessageInput,
  ): Promise<void> {
    if (!(await isConversationMember(this.db, conversationId, userId))) {
      throw new NotFoundException('Conversation not found');
    }
    // A plain read: filing a report must not hold up the sender editing or deleting. If the
    // message is deleted a moment later, the copy of the text taken here is what gets reviewed.
    const message = await findMessage(this.db, messageId);
    if (!message || message.conversationId !== conversationId) {
      throw new NotFoundException('Message not found');
    }
    if (message.senderId === userId) {
      throw new BadRequestException('You can’t report your own message');
    }
    if (message.type === 'system' || message.type === 'call') {
      throw new BadRequestException('You can’t report this message');
    }
    // A deleted message has no text left to review (its content is wiped), so there is nothing
    // to report; report it before it is deleted.
    if (message.deletedAt) throw new BadRequestException('This message was deleted');
    // CHAT-077: the server can't read an end-to-end encrypted message, so the reporter's device
    // sends the text it decrypted; moderators see that it came from the reporter (unverified).
    const encrypted = !!message.meta?.e2ee;
    const fromReporter = encrypted && !!input.decryptedText?.length;
    await upsertMessageReport(this.db, {
      reporterId: userId,
      reportedUserId: message.senderId,
      conversationId,
      messageId,
      reason: input.reason,
      details: input.details?.length ? input.details : null,
      bodySnapshot: fromReporter ? input.decryptedText! : message.body,
      snapshotFromReporter: fromReporter,
    });
    this.logger.warn({
      event: 'message.reported',
      conversationId,
      messageId,
      reporterId: userId,
      reportedUserId: message.senderId,
      reason: input.reason,
    });
  }

  /** CHAT-077: report a person, from a chat you're both in. */
  async reportUser(userId: string, reportedUserId: string, input: ReportUserInput): Promise<void> {
    if (reportedUserId === userId) throw new BadRequestException('You can’t report yourself');
    if (!(await isConversationMember(this.db, input.conversationId, userId))) {
      throw new NotFoundException('Conversation not found');
    }
    // Members past or present: someone who left (or was removed) after harassing you can still
    // be reported from that chat.
    if (!(await wasConversationMember(this.db, input.conversationId, reportedUserId))) {
      throw new NotFoundException('That person isn’t in this conversation');
    }
    await upsertUserReport(this.db, {
      reporterId: userId,
      reportedUserId,
      conversationId: input.conversationId,
      reason: input.reason,
      details: input.details?.length ? input.details : null,
    });
    this.logger.warn({
      event: 'user.reported',
      conversationId: input.conversationId,
      reporterId: userId,
      reportedUserId,
      reason: input.reason,
    });
  }
}
