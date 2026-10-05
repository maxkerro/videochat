import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PushPayload } from '@videochat/shared';
import webpush from 'web-push';
import type { Env } from '../config/env.js';
import type { PushDevice } from '../db/devices.js';
import { ENV } from '../infra/tokens.js';
import type { PushChannel, PushResult } from './push-channel.js';

/** CHAT-035: browser push via the Web Push protocol, signed with this server's VAPID keys. */
@Injectable()
export class WebPushChannel implements PushChannel {
  readonly platform = 'web' as const;
  readonly enabled: boolean;
  private readonly logger = new Logger(WebPushChannel.name);

  constructor(@Inject(ENV) private readonly env: Env) {
    this.enabled = !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY;
    if (this.enabled) {
      webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    }
  }

  get publicKey(): string | null {
    return this.enabled ? this.env.VAPID_PUBLIC_KEY : null;
  }

  async send(device: PushDevice, payload: PushPayload): Promise<PushResult> {
    if (!this.enabled || !device.keys) return 'failed';
    try {
      await webpush.sendNotification(
        { endpoint: device.token, keys: device.keys },
        JSON.stringify(payload),
        // A message notification is stale after a day; `topic` lets the push service replace an
        // undelivered one for the same conversation instead of queueing a pile.
        { TTL: 24 * 60 * 60, urgency: 'high', topic: payload.tag.slice(0, 32) },
      );
      return 'sent';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'gone';
      this.logger.warn(`Web push failed (${status ?? 'network'}): ${(err as Error).message}`);
      return 'failed';
    }
  }
}
