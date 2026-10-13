import type { PushPayload } from '@videochat/shared';
import type { Env } from '../config/env.js';
import type { PushDevice } from '../db/devices.js';
import {
  ANDROID_CHANNEL,
  ANDROID_CHANNEL_SILENT,
  FcmPushChannel,
  buildFcmCallMessage,
  buildFcmMessage,
  isDeadToken,
  parseServiceAccount,
} from './fcm-push.channel.js';

const payload: PushPayload = {
  title: 'Anna',
  body: 'hello',
  conversationId: '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c',
  url: '/c/3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c',
  tag: 'conv-3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c',
};
const device: PushDevice = {
  id: 'd',
  userId: 'u',
  platform: 'android',
  token: 'tok',
  keys: null,
};

describe('buildFcmMessage', () => {
  it('addresses the token, carries the deep link, and groups per conversation', () => {
    const { message } = buildFcmMessage('tok', payload);
    expect(message.token).toBe('tok');
    expect(message.data).toEqual({
      conversationId: payload.conversationId,
      url: payload.url,
      tag: payload.tag,
    });
    expect(message.android.notification).toMatchObject({
      title: 'Anna',
      body: 'hello',
      tag: payload.tag,
      channel_id: ANDROID_CHANNEL,
    });
    expect(message.android.collapse_key).toBe(payload.tag);
  });

  it('uses the silent channel when the person turned sounds off', () => {
    const { message } = buildFcmMessage('tok', { ...payload, silent: true });
    expect(message.android.notification.channel_id).toBe(ANDROID_CHANNEL_SILENT);
  });
});

describe('buildFcmCallMessage', () => {
  const call = {
    callId: '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c',
    conversationId: '9a1b2c3d-0000-4000-8000-000000000001',
    hasVideo: true,
    startedAt: '2026-10-13T10:00:00.000Z',
    caller: { id: 'u1', displayName: 'Anna', avatarUrl: null },
  };

  it('is a data-only, high-priority message the native call library recognises', () => {
    const { message } = buildFcmCallMessage('tok', call);
    expect(message.token).toBe('tok');
    expect(message.data.messageType).toBe('incomingCall');
    expect(JSON.parse(message.data.incomingCall)).toEqual({
      eventId: call.callId,
      serverCallId: call.callId,
      hasVideo: true,
      startedAt: call.startedAt,
      caller: call.caller,
      metadata: { conversationId: call.conversationId },
    });
    // A `notification` block would show a plain notification instead of waking the app.
    const whole = buildFcmCallMessage('tok', call);
    expect(whole.message).not.toHaveProperty('notification');
    expect(message.android).not.toHaveProperty('notification');
    expect(message.android.priority).toBe('HIGH');
    expect(message.android.ttl).toBe('30s');
  });
});

describe('parseServiceAccount', () => {
  it('accepts a service-account key and rejects everything else', () => {
    const key = { project_id: 'p', client_email: 'e@p.iam', private_key: 'k' };
    expect(parseServiceAccount(JSON.stringify(key))).toMatchObject({ project_id: 'p' });
    expect(parseServiceAccount('')).toBeNull();
    expect(parseServiceAccount('not json')).toBeNull();
    expect(parseServiceAccount('{"project_id":"p"}')).toBeNull();
  });
});

describe('isDeadToken', () => {
  it('only an unregistered token is dead', () => {
    expect(
      isDeadToken(404, {
        error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
      }),
    ).toBe(true);
    expect(isDeadToken(404, { error: { status: 'NOT_FOUND' } })).toBe(true);
    expect(isDeadToken(400, { error: { status: 'INVALID_ARGUMENT' } })).toBe(false);
    expect(isDeadToken(503, null)).toBe(false);
  });
});

describe('FcmPushChannel', () => {
  it('is off without a key, and a send then fails harmlessly', async () => {
    const channel = new FcmPushChannel({ FCM_SERVICE_ACCOUNT_JSON: '' } as Env);
    expect(channel.enabled).toBe(false);
    await expect(channel.send(device, payload)).resolves.toBe('failed');
  });

  it('is on with a usable key', () => {
    const key = JSON.stringify({ project_id: 'p', client_email: 'e@p.iam', private_key: 'k' });
    expect(new FcmPushChannel({ FCM_SERVICE_ACCOUNT_JSON: key } as Env).enabled).toBe(true);
  });
});

describe('FcmPushChannel.send', () => {
  const key = JSON.stringify({ project_id: 'proj', client_email: 'e@p.iam', private_key: 'k' });

  function channelWith(response: Response | Error) {
    const channel = new FcmPushChannel({ FCM_SERVICE_ACCOUNT_JSON: key } as Env);
    (channel as unknown as { auth: { getAccessToken: () => Promise<string> } }).auth = {
      getAccessToken: () => Promise.resolve('access'),
    };
    const fetchImpl = vi.fn(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    );
    channel.fetchImpl = fetchImpl;
    return { channel, fetchImpl };
  }

  it('posts to the project endpoint with a bearer token', async () => {
    const { channel, fetchImpl } = channelWith(new Response('{}', { status: 200 }));
    await expect(channel.send(device, payload)).resolves.toBe('sent');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fcm.googleapis.com/v1/projects/proj/messages:send');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access');
  });

  it('reports an unregistered token as gone', async () => {
    const body = { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } };
    const { channel } = channelWith(new Response(JSON.stringify(body), { status: 404 }));
    await expect(channel.send(device, payload)).resolves.toBe('gone');
  });

  it('keeps the token on outages and network errors', async () => {
    await expect(
      channelWith(new Response('{}', { status: 503 })).channel.send(device, payload),
    ).resolves.toBe('failed');
    await expect(channelWith(new Error('boom')).channel.send(device, payload)).resolves.toBe(
      'failed',
    );
  });
});
