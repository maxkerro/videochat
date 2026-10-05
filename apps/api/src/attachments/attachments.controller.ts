import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  attachmentUrlQuerySchema,
  createAttachmentUploadSchema,
  type AttachmentUpload,
  type AttachmentUrl,
} from '@videochat/shared';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MessageThrottlerGuard } from '../rate-limit/rate-limit.guards.js';
import { AttachmentsService } from './attachments.service.js';

/** CHAT-030. */
@Controller()
@UseGuards(AccessTokenGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** Step 1 of sending a file: a signed URL to upload it to. Rate-limited like sending, since
   *  each one is a message in waiting. */
  @Post('conversations/:conversationId/attachments')
  @UseGuards(MessageThrottlerGuard)
  createUpload(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(createAttachmentUploadSchema))
    body: z.infer<typeof createAttachmentUploadSchema>,
  ): Promise<AttachmentUpload> {
    return this.attachments.createUpload(userId, conversationId, body);
  }

  /** A short-lived signed URL to view or download an attachment; members only. */
  @Get('attachments/:attachmentId/url')
  getUrl(
    @Param('attachmentId', UuidParamPipe) attachmentId: string,
    @CurrentUserId() userId: string,
    @Query(new ZodValidationPipe(attachmentUrlQuerySchema))
    query: z.infer<typeof attachmentUrlQuerySchema>,
  ): Promise<AttachmentUrl> {
    return this.attachments.getUrl(userId, attachmentId, query.variant);
  }
}
