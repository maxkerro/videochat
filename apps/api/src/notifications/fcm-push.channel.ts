import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PushPayload } from '@videochat/shared';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import type { PushDevice } from '../db/devices.js';
import { ENV } from '../infra/tokens.js';
import type { IncomingCallPush, PushChannel, PushResult } from './push-channel.js';

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

/** Android notification channels the app creates (see apps/mobile/src/push). */
export const ANDROID_CHANNEL = 'messages';
export const ANDROID_CHANNEL_SILENT = 'messages-silent';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Builds the FCM HTTP v1 message for one device. Exported for tests. */
export function buildFcmMessage(token: string, payload: PushPayload) {
  return {
    message: {
      token,
      // `data` reaches the app when the notification is tapped (deep link to the conversation).
      data: { conversationId: payload.conversationId, url: payload.url, tag: payload.tag },
      android: {
        priority: 'HIGH',
        ttl: '86400s',
        // A newer message for the same conversation replaces an undelivered older one.
        collapse_key: payload.tag.slice(0, 64),
        notification: {
          title: payload.title,
          body: payload.body,
          // The same tag replaces the shown notification, so one conversation = one entry.
          tag: payload.tag,
          channel_id: payload.silent ? ANDROID_CHANNEL_SILENT : ANDROID_CHANNEL,
        },
      },
    },
  };
}

/** How long FCM keeps a ring request: a call nobody can answer any more must not ring later. */
export const CALL_PUSH_TTL_SEC = 30;

/**
 * CHAT-061: a data-only, high-priority message. The native call library's FCM service (in the
 * app) recognises `messageType: 'incomingCall'` and shows the system call screen, even with the
 * app killed. No `notification` block: that would make the system show a plain notification
 * instead of waking the app.
 */
export function buildFcmCallMessage(token: string, call: IncomingCallPush) {
  return {
    message: {
      token,
      data: {
        messageType: 'incomingCall',
        incomingCall: JSON.stringify({
          eventId: call.callId,
          serverCallId: call.callId,
          hasVideo: call.hasVideo,
          startedAt: call.startedAt,
          caller: call.caller,
          // The app is started by this push with nothing else to go on: the conversation travels
          // here (read back by `incomingInfoOf` in apps/mobile/src/calls/callBridge.ts).
          metadata: { conversationId: call.conversationId },
        }),
      },
      android: {
        priority: 'HIGH',
        ttl: `${CALL_PUSH_TTL_SEC}s`,
        // Only the newest ring request for a call id matters.
        collapse_key: `call-${call.callId}`.slice(0, 64),
      },
    },
  };
}

/**
 * CHAT-055: push to Android phones through Firebase Cloud Messaging (HTTP v1). Authenticates with
 * a service-account key from `FCM_SERVICE_ACCOUNT_JSON`; without it the channel is off and the rest
 * of the app is unaffected. A token FCM says no longer exists is reported `gone` so the service
 * deletes it.
 */
@Injectable()
export class FcmPushChannel implements PushChannel {
  readonly platform = 'android' as const;
  readonly enabled: boolean;
  private readonly logger = new Logger(FcmPushChannel.name);
  private readonly projectId: string = '';
  private readonly auth: GoogleAuth | null = null;

  /** Replaceable in tests. */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(@Inject(ENV) env: Env) {
    const parsed = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON);
    if (env.FCM_SERVICE_ACCOUNT_JSON && !parsed) {
      this.logger.warn('FCM_SERVICE_ACCOUNT_JSON is set but is not a usable service-account key');
    }
    this.enabled = parsed !== null;
    if (parsed) {
      this.projectId = parsed.project_id;
      this.auth = new GoogleAuth({
        credentials: { client_email: parsed.client_email, private_key: parsed.private_key },
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
      });
    }
  }

  async send(device: PushDevice, payload: PushPayload): Promise<PushResult> {
    return this.post(buildFcmMessage(device.token, payload));
  }

  async sendIncomingCall(device: PushDevice, call: IncomingCallPush): Promise<PushResult> {
    return this.post(buildFcmCallMessage(device.token, call));
  }

  private async post(message: object): Promise<PushResult> {
    if (!this.auth) return 'failed';
    try {
      const accessToken = await this.auth.getAccessToken();
      const res = await this.fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(message),
        },
      );
      if (res.ok) return 'sent';
      const body = (await res.json().catch(() => null)) as {
        error?: { status?: string; details?: Array<{ errorCode?: string }> };
      } | null;
      if (isDeadToken(res.status, body)) return 'gone';
      this.logger.warn(`FCM push failed (${res.status}): ${body?.error?.status ?? 'unknown'}`);
      return 'failed';
    } catch (err) {
      this.logger.warn(`FCM push failed: ${(err as Error).message}`);
      return 'failed';
    }
  }
}

export function parseServiceAccount(raw: string): z.infer<typeof serviceAccountSchema> | null {
  if (!raw.trim()) return null;
  try {
    const parsed = serviceAccountSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** FCM answers 404 UNREGISTERED for an uninstalled app. Anything else (a 400 can be our own payload,
 *  quota, outage, auth) is not proof the token is dead, so it is kept and retried later. */
export function isDeadToken(
  status: number,
  body: { error?: { status?: string; details?: Array<{ errorCode?: string }> } } | null,
): boolean {
  const code = body?.error?.details?.find((d) => d.errorCode)?.errorCode;
  if (code === 'UNREGISTERED') return true;
  if (status === 404 && body?.error?.status === 'NOT_FOUND') return true;
  return false;
}
