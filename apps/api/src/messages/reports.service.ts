import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ReportMessageInput } from '@videochat/shared';
import type { Database } from '../db/client.js';
import { isConversationMember } from '../db/conversations.js';
import { upsertMessageReport } from '../db/message-reports.js';
import { findMessage } from '../db/messages.js';
import { DB } from '../infra/tokens.js';

/**
 * CHAT-058: "report this message" -- the report mechanism the app stores require for user-generated
 * content. Any member can report someone else's message. The report keeps a copy of the text (the
 * sender may edit or delete it afterwards) and goes to the structured log so it can be alerted on;
 * there is no moderation UI yet.
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
    await upsertMessageReport(this.db, {
      reporterId: userId,
      reportedUserId: message.senderId,
      conversationId,
      messageId,
      reason: input.reason,
      details: input.details?.length ? input.details : null,
      bodySnapshot: message.body,
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
}
