import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Database } from '../db/client.js';
import * as conversationsDb from '../db/conversations.js';
import * as messagesDb from '../db/messages.js';
import * as reactionsDb from '../db/reactions.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import { ReactionsService } from './reactions.service.js';

vi.mock('../db/conversations.js', () => ({ isConversationMember: vi.fn() }));
vi.mock('../db/messages.js', () => ({ findMessage: vi.fn() }));
vi.mock('../db/reactions.js', () => ({ toggleReaction: vi.fn(), listReactions: vi.fn() }));

describe('ReactionsService (CHAT-033)', () => {
  const realtime = { publishToConversation: vi.fn().mockResolvedValue(undefined) };
  const service = new ReactionsService({} as Database, realtime as unknown as RealtimeService);
  const message = { id: 'm', conversationId: 'c', deletedAt: null, type: 'text' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
    vi.mocked(messagesDb.findMessage).mockResolvedValue(message as never);
    vi.mocked(reactionsDb.listReactions).mockResolvedValue(
      new Map([['m', [{ emoji: '👍', count: 1, userIds: ['u'] }]]]),
    );
  });

  it('toggles and broadcasts the regrouped set', async () => {
    vi.mocked(reactionsDb.toggleReaction).mockResolvedValue('added');
    const result = await service.toggle('c', 'u', 'm', '👍');
    expect(result.reactions).toEqual([{ emoji: '👍', count: 1, userIds: ['u'] }]);
    expect(realtime.publishToConversation).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ type: 'message.reactions' }),
    );
  });

  it('refuses outsiders, other conversations, deleted messages and the distinct-emoji cap', async () => {
    vi.mocked(conversationsDb.isConversationMember).mockResolvedValueOnce(false);
    await expect(service.toggle('c', 'u', 'm', '👍')).rejects.toThrow(NotFoundException);
    vi.mocked(messagesDb.findMessage).mockResolvedValueOnce({
      ...message,
      conversationId: 'x',
    } as never);
    await expect(service.toggle('c', 'u', 'm', '👍')).rejects.toThrow(NotFoundException);
    vi.mocked(messagesDb.findMessage).mockResolvedValueOnce({
      ...message,
      deletedAt: new Date(),
    } as never);
    await expect(service.toggle('c', 'u', 'm', '👍')).rejects.toThrow(BadRequestException);
    vi.mocked(reactionsDb.toggleReaction).mockResolvedValue('limit');
    await expect(service.toggle('c', 'u', 'm', '👍')).rejects.toThrow(/at most/);
    expect(realtime.publishToConversation).not.toHaveBeenCalled();
  });
});
