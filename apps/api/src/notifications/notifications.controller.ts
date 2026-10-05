import { Body, Controller, Delete, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { pushSubscriptionSchema, pushUnsubscribeSchema } from '@videochat/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Inject } from '@nestjs/common';
import type { Database } from '../db/client.js';
import { deletePushDevice, upsertWebPushDevice } from '../db/devices.js';
import { DB } from '../infra/tokens.js';
import { WebPushChannel } from './web-push.channel.js';

/** CHAT-035: web push registration. */
@Controller('push')
export class NotificationsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly webPush: WebPushChannel,
  ) {}

  /** Public: the browser needs it to subscribe. null when push is switched off. */
  @Get('vapid-public-key')
  vapidPublicKey(): { publicKey: string | null } {
    return { publicKey: this.webPush.publicKey };
  }

  @Post('subscriptions')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async subscribe(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(pushSubscriptionSchema))
    body: z.infer<typeof pushSubscriptionSchema>,
    @Req() req: Request,
  ): Promise<void> {
    const ua = req.headers['user-agent']?.slice(0, 255) ?? null;
    await upsertWebPushDevice(this.db, userId, body.endpoint, body.keys, ua);
  }

  @Delete('subscriptions')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async unsubscribe(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(pushUnsubscribeSchema)) body: z.infer<typeof pushUnsubscribeSchema>,
  ): Promise<void> {
    await deletePushDevice(this.db, body.endpoint, userId);
  }
}
