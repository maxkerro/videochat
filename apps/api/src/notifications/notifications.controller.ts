import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  nativePushRegistrationSchema,
  nativePushUnregisterSchema,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
} from '@videochat/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { hashToken } from '../auth/tokens.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Inject } from '@nestjs/common';
import type { Database } from '../db/client.js';
import { deletePushDevice, upsertNativePushDevice, upsertWebPushDevice } from '../db/devices.js';
import { findRefreshTokenByHash, isFamilyLive } from '../db/refresh-tokens.js';
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
    // The refresh token proves which login session this phone belongs to (and that it is still
    // alive); the token is only looked up here, never stored.
    // Deliberately lenient: an already-rotated token is accepted as long as its *family* is live.
    // The phone reads its refresh token before this POST, and the POST's own auth may refresh and
    // rotate it mid-request, so rejecting rotated tokens (or treating them as reuse) would break
    // registration. Do not tighten this to the token itself.
    const session = await findRefreshTokenByHash(this.db, hashToken(body.refreshToken));
    if (!session || session.userId !== userId || !(await isFamilyLive(this.db, session.familyId))) {
      throw new UnauthorizedException('Invalid session');
    }
    const ua = req.headers['user-agent']?.slice(0, 255) ?? null;
    await upsertNativePushDevice(this.db, userId, body.platform, body.token, ua, session.familyId);
    // The session may have been revoked between the check above and the insert (a sign-out whose
    // DELETE ran first would otherwise leave this row bound to a dead session). Re-check now: if the
    // revoke came before the insert we see it here; if after, its DELETE removed the row. (Sending
    // also skips devices of dead sessions, so this is belt and braces.)
    if (!(await isFamilyLive(this.db, session.familyId))) {
      await deletePushDevice(this.db, body.token, userId);
      throw new UnauthorizedException('Invalid session');
    }
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
