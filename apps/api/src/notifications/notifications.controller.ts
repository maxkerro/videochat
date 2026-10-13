import { Body, Controller, Delete, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import {
  nativePushRegistrationSchema,
  nativePushUnregisterSchema,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
} from '@videochat/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Inject } from '@nestjs/common';
import type { Database } from '../db/client.js';
import { deletePushDevice, upsertNativePushDevice, upsertWebPushDevice } from '../db/devices.js';
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

  /** CHAT-055: the mobile app registers its FCM/APNs token after sign-in. */
  @Post('devices')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async registerDevice(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(nativePushRegistrationSchema))
    body: z.infer<typeof nativePushRegistrationSchema>,
    @Req() req: Request,
  ): Promise<void> {
    const ua = req.headers['user-agent']?.slice(0, 255) ?? null;
    await upsertNativePushDevice(this.db, userId, body.platform, body.token, ua);
  }

  /** CHAT-055: sign-out on the phone removes its token so the next person gets no pushes meant
   *  for this account. Only the owner's own token can be removed. */
  @Delete('devices')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async unregisterDevice(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(nativePushUnregisterSchema))
    body: z.infer<typeof nativePushUnregisterSchema>,
  ): Promise<void> {
    await deletePushDevice(this.db, body.token, userId);
  }
}
