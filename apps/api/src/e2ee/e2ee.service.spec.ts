import { NotFoundException, BadRequestException } from '@nestjs/common';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import * as conversationsDb from '../db/conversations.js';
import * as e2eeDb from '../db/e2ee.js';
import { E2eeService } from './e2ee.service.js';

vi.mock('../db/conversations.js');
vi.mock('../db/e2ee.js');

const service = (on: boolean) =>
  new E2eeService({} as Database, { E2EE_PROTOTYPE: on } as unknown as Env);

describe('E2eeService (CHAT-076 spike)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('answers 404 for every directory call while the flag is off', async () => {
    const off = service(false);
    await expect(off.registerDevice('u')).rejects.toBeInstanceOf(NotFoundException);
    await expect(off.welcomes('u', 'd')).rejects.toBeInstanceOf(NotFoundException);
    await expect(off.getGroup('u', 'c')).rejects.toBeInstanceOf(NotFoundException);
    await expect(off.assertCanSendEncrypted('c')).rejects.toBeInstanceOf(BadRequestException);
    expect(e2eeDb.createE2eeDevice).not.toHaveBeenCalled();
  });

  it('allows encrypted sends only in a direct chat that has a group', async () => {
    const on = service(true);
    vi.mocked(conversationsDb.findConversationBasics).mockResolvedValue({
      type: 'group',
      title: 'T',
    });
    await expect(on.assertCanSendEncrypted('c')).rejects.toThrow(/direct chats/);

    vi.mocked(conversationsDb.findConversationBasics).mockResolvedValue({
      type: 'direct',
      title: null,
    });
    vi.mocked(e2eeDb.findE2eeGroup).mockResolvedValue(undefined);
    await expect(on.assertCanSendEncrypted('c')).rejects.toThrow(/no encryption group/);

    vi.mocked(e2eeDb.findE2eeGroup).mockResolvedValue({
      conversationId: 'c',
      creatorDeviceId: 'd',
      createdAt: new Date(),
    });
    await expect(on.assertCanSendEncrypted('c')).resolves.toBeUndefined();
  });
});
