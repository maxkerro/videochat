import type { Redis } from 'ioredis';
import * as blocksDb from '../db/blocks.js';
import type { Database } from '../db/client.js';
import * as conversationsDb from '../db/conversations.js';
import * as devicesDb from '../db/devices.js';
import type { MessageRow } from '../db/schema.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import { NotificationsService, notificationText } from './notifications.service.js';
import type { PushChannel } from './push-channel.js';

vi.mock('../db/blocks.js', () => ({ isBlocked: vi.fn() }));
vi.mock('../db/conversations.js', () => ({
  listNotifiableMembers: vi.fn(),
  findConversationForUser: vi.fn(),
}));
vi.mock('../db/devices.js', () => ({
  listPushDevices: vi.fn(),
  deletePushDevice: vi.fn(),
  getNotificationPrefs: vi.fn(),
}));
vi.mock('../db/users.js', () => ({ findUserById: vi.fn(async () => ({ displayName: 'Anna' })) }));

const row = {
  id: 'm',
  conversationId: 'conv',
  senderId: 'anna',
  type: 'text',
  body: 'hello',
  meta: null,
} as unknown as MessageRow;

describe('notificationText', () => {
  it('describes text, photos and files', () => {
    expect(notificationText({ type: 'text', body: 'hi', meta: null })).toBe('hi');
    expect(
      notificationText({
        type: 'image',
        body: null,
        meta: { attachment: { kind: 'image', filename: 'a.jpg' } as never },
      }),
    ).toBe('Photo');
    expect(
      notificationText({
        type: 'file',
        body: 'numbers',
        meta: { attachment: { kind: 'file', filename: 'q3.pdf' } as never },
      }),
    ).toBe('q3.pdf: numbers');
    expect(notificationText({ type: 'text', body: 'x'.repeat(300), meta: null })).toHaveLength(140);
  });
});

describe('NotificationsService', () => {
  let viewing: Record<string, string[]>;
  let channel: { platform: 'web'; enabled: boolean; send: ReturnType<typeof vi.fn> };
  let service: NotificationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    viewing = {};
    channel = { platform: 'web', enabled: true, send: vi.fn().mockResolvedValue('sent') };
    const redis = { hvals: vi.fn(async (k: string) => viewing[k] ?? []) };
    service = new NotificationsService(
      {} as Database,
      redis as unknown as Redis,
      {} as RealtimeService,
      [channel as unknown as PushChannel],
    );
    vi.mocked(conversationsDb.listNotifiableMembers).mockResolvedValue(['ben', 'clara']);
    vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue({
      type: 'direct',
    } as never);
    vi.mocked(blocksDb.isBlocked).mockResolvedValue(false);
    vi.mocked(devicesDb.getNotificationPrefs).mockResolvedValue(new Map());
    vi.mocked(devicesDb.listPushDevices).mockImplementation(async (_db, ids) =>
      ids.map((id) => ({
        id,
        userId: id,
        platform: 'web' as const,
        token: `ep-${id}`,
        keys: { p256dh: 'p', auth: 'a' },
      })),
    );
  });

  it('skips members looking at the conversation and members who blocked the sender', async () => {
    viewing['viewing:ben'] = ['conv'];
    vi.mocked(blocksDb.isBlocked).mockImplementation(async (_db, blocker) => blocker === 'clara');
    await service.notifyNewMessage(row);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('sends to everyone else and removes subscriptions the push service says are gone', async () => {
    channel.send.mockImplementation(async (d: { userId: string }) =>
      d.userId === 'clara' ? 'gone' : 'sent',
    );
    await service.notifyNewMessage(row);
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send.mock.calls[0]![1]).toMatchObject({
      title: 'Anna',
      body: 'hello',
      url: '/c/conv',
    });
    expect(devicesDb.deletePushDevice).toHaveBeenCalledWith({}, 'ep-clara');
  });

  it('does nothing when push is switched off, or for system messages', async () => {
    channel.enabled = false;
    await service.notifyNewMessage(row);
    channel.enabled = true;
    await service.notifyNewMessage({ ...row, type: 'system' } as MessageRow);
    expect(conversationsDb.listNotifiableMembers).not.toHaveBeenCalled();
  });

  it("honours each person's settings: off, no previews, no sound", async () => {
    vi.mocked(devicesDb.getNotificationPrefs).mockResolvedValue(
      new Map([
        ['ben', { enabled: true, sound: false, previews: false }],
        ['clara', { enabled: false, sound: true, previews: true }],
      ]),
    );
    await service.notifyNewMessage(row);
    expect(devicesDb.listPushDevices).toHaveBeenCalledWith({}, ['ben']);
    expect(channel.send.mock.calls[0]![1]).toMatchObject({ body: 'New message', silent: true });
  });

  it("a missed call keeps its text with previews off (there's no content to hide)", async () => {
    vi.mocked(devicesDb.getNotificationPrefs).mockResolvedValue(
      new Map([['ben', { enabled: true, sound: true, previews: false }]]),
    );
    await service.notifyMissedCall({
      id: 'call-1',
      conversationId: 'conv',
      callerId: 'anna',
      calleeId: 'ben',
      media: 'audio',
      silenced: false,
    } as never);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0]![1]).toMatchObject({ body: 'Missed audio call' });
  });

  it('skips anyone whose notifications are off (a deleted account always counts as off)', async () => {
    vi.mocked(devicesDb.getNotificationPrefs).mockResolvedValue(
      new Map([
        ['ben', { enabled: false, sound: true, previews: true }],
        ['clara', { enabled: true, sound: true, previews: true }],
      ]),
    );
    await service.notifyNewMessage(row);
    expect(devicesDb.listPushDevices).toHaveBeenCalledWith({}, ['clara']);
  });
});
