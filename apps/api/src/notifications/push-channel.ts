import type { PushPayload } from '@videochat/shared';
import type { PushDevice } from '../db/devices.js';

/** The result of one push: `gone` means the subscription/token is dead and should be removed. */
export type PushResult = 'sent' | 'gone' | 'failed';

/**
 * CHAT-035: one way of delivering a push to a device. Web Push today; APNs and FCM (CHAT-055)
 * plug in as more channels for the `ios` / `android` platforms without touching the service.
 */
export interface PushChannel {
  readonly platform: PushDevice['platform'];
  readonly enabled: boolean;
  send(device: PushDevice, payload: PushPayload): Promise<PushResult>;
}

export const PUSH_CHANNELS = Symbol('PUSH_CHANNELS');
