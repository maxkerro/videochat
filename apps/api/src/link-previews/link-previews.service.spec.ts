import type { Redis } from 'ioredis';
import type { Database } from '../db/client.js';
import * as messagesDb from '../db/messages.js';
import type { MessageRow } from '../db/schema.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { LinkPreviewFetcher } from './link-preview.fetcher.js';
import { LinkPreviewsService } from './link-previews.service.js';

vi.mock('../db/messages.js', () => ({ setMessageLinkPreview: vi.fn(), findMessage: vi.fn() }));
vi.mock('../db/conversations.js', () => ({ isConversationMember: vi.fn(async () => true) }));

const preview = {
  url: 'https://a.dev/',
  title: 'A',
  description: null,
  siteName: null,
  imageUrl: null,
};

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
    conversationId: 'conv',
    seq: 1,
    senderId: 'anna',
    clientMsgId: 'c',
    type: 'text',
    body: 'look https://a.dev/',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    meta: null,
    ...overrides,
  };
}

describe('LinkPreviewsService', () => {
  let store: Map<string, string>;
  let fetcher: { fetchPreview: ReturnType<typeof vi.fn> };
  let realtime: { publishToConversation: ReturnType<typeof vi.fn> };
  let service: LinkPreviewsService;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new Map();
    const redis = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    };
    fetcher = { fetchPreview: vi.fn().mockResolvedValue(preview) };
    realtime = { publishToConversation: vi.fn().mockResolvedValue(undefined) };
    service = new LinkPreviewsService(
      {} as Database,
      redis as unknown as Redis,
      realtime as unknown as RealtimeService,
      fetcher as unknown as LinkPreviewFetcher,
    );
  });

  it('caches previews (and misses) so a URL is fetched once', async () => {
    await service.getPreview('https://a.dev/');
    await service.getPreview('https://a.dev/');
    expect(fetcher.fetchPreview).toHaveBeenCalledTimes(1);

    fetcher.fetchPreview.mockRejectedValue(new Error('refused'));
    await expect(service.getPreview('https://b.dev/')).resolves.toBeNull();
    await expect(service.getPreview('https://b.dev/')).resolves.toBeNull();
    expect(fetcher.fetchPreview).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between concurrent requests for the same URL', async () => {
    await Promise.all([service.getPreview('https://c.dev/'), service.getPreview('https://c.dev/')]);
    expect(fetcher.fetchPreview).toHaveBeenCalledTimes(1);
  });

  it('adds the preview to the message and announces message.updated', async () => {
    vi.mocked(messagesDb.setMessageLinkPreview).mockResolvedValue(
      row({ meta: { linkPreview: preview } }),
    );
    await service.attachToMessage(row());
    expect(messagesDb.setMessageLinkPreview).toHaveBeenCalledWith(
      {},
      '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
      preview,
      'look https://a.dev/',
    );
    const [, envelope] = realtime.publishToConversation.mock.calls[0]!;
    expect(envelope).toMatchObject({ type: 'message.updated', payload: { linkPreview: preview } });
  });

  it('stays quiet when the message changed meanwhile, and never throws', async () => {
    vi.mocked(messagesDb.setMessageLinkPreview).mockResolvedValue(undefined);
    await service.attachToMessage(row());
    expect(realtime.publishToConversation).not.toHaveBeenCalled();
    fetcher.fetchPreview.mockRejectedValue(new Error('boom'));
    await expect(service.attachToMessage(row({ body: 'https://z.dev/' }))).resolves.toBeUndefined();
  });

  it('lets only the sender remove a preview', async () => {
    vi.mocked(messagesDb.findMessage).mockResolvedValue(row({ meta: { linkPreview: preview } }));
    await expect(service.removeFromMessage('ben', 'conv', row().id)).rejects.toThrow(/sender/);
    vi.mocked(messagesDb.setMessageLinkPreview).mockResolvedValue(row());
    await service.removeFromMessage('anna', 'conv', row().id);
    expect(messagesDb.setMessageLinkPreview).toHaveBeenCalledWith({}, row().id, null);
    await expect(service.removeFromMessage('anna', 'other-conv', row().id)).rejects.toThrow(
      /not found/,
    );
  });
});
