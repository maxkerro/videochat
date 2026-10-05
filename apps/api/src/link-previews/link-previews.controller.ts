import { Controller, Delete, Get, HttpCode, Param, Query, UseGuards } from '@nestjs/common';
import { linkPreviewQuerySchema, type LinkPreviewResponse } from '@videochat/shared';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SearchThrottlerGuard } from '../rate-limit/rate-limit.guards.js';
import { UlidParamPipe } from '../common/ulid-param.pipe.js';
import { LinkPreviewsService } from './link-previews.service.js';

/** CHAT-031. */
@Controller()
@UseGuards(AccessTokenGuard)
export class LinkPreviewsController {
  constructor(private readonly previews: LinkPreviewsService) {}

  /** The composer's preview while typing (so it can be dismissed before sending). Rate-limited
   *  per user like search: each miss is an outbound fetch. */
  @Get('link-preview')
  @UseGuards(SearchThrottlerGuard)
  async get(
    @Query(new ZodValidationPipe(linkPreviewQuerySchema))
    query: z.infer<typeof linkPreviewQuerySchema>,
  ): Promise<LinkPreviewResponse> {
    return { preview: await this.previews.getPreview(query.url) };
  }

  /** The sender removes a sent message's preview. */
  @Delete('conversations/:conversationId/messages/:messageId/link-preview')
  @HttpCode(204)
  async remove(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @Param('messageId', UlidParamPipe) messageId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.previews.removeFromMessage(userId, conversationId, messageId);
  }
}
