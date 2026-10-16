import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ClaimedKeyPackages,
  CreateE2eeGroupInput,
  E2eeDevice,
  E2eeGroup,
  E2eeWelcome,
} from '@videochat/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { findConversationBasics, isConversationMember } from '../db/conversations.js';
import {
  addKeyPackages,
  claimKeyPackages,
  countKeyPackages,
  createE2eeDevice,
  deleteWelcome,
  findE2eeGroup,
  insertE2eeGroup,
  insertWelcomes,
  isActiveDeviceOf,
  listMemberDevices,
  listWelcomes,
} from '../db/e2ee.js';
import type { E2eeGroupRow } from '../db/schema.js';
import { DB, ENV } from '../infra/tokens.js';

/**
 * CHAT-076 (spike): the MLS key directory. The server hands out public key packages, records
 * that a conversation has a group, and stores welcomes for devices to pick up. It can't read
 * messages: it never sees a private key or a group secret.
 */
@Injectable()
export class E2eeService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get enabled(): boolean {
    return this.env.E2EE_PROTOTYPE;
  }

  async registerDevice(userId: string): Promise<E2eeDevice> {
    this.requireEnabled();
    return { deviceId: await createE2eeDevice(this.db, userId), userId };
  }

  async uploadKeyPackages(
    userId: string,
    deviceId: string,
    keyPackages: string[],
  ): Promise<{ count: number }> {
    await this.requireDevice(userId, deviceId);
    return { count: await addKeyPackages(this.db, deviceId, keyPackages) };
  }

  async keyPackageCount(userId: string, deviceId: string): Promise<{ count: number }> {
    await this.requireDevice(userId, deviceId);
    return { count: await countKeyPackages(this.db, deviceId) };
  }

  /** One key package for every other active device in the conversation (the caller's own other
   *  devices included), so the caller can add them all to the group. */
  async claim(
    userId: string,
    conversationId: string,
    deviceId: string,
  ): Promise<ClaimedKeyPackages> {
    await this.requireDevice(userId, deviceId);
    await this.requireDirectConversation(conversationId, userId);
    return this.db.transaction(async (tx) => {
      const devices = await listMemberDevices(tx, conversationId, deviceId);
      const claimed = await claimKeyPackages(
        tx,
        devices.map((d) => d.deviceId),
      );
      const keyPackages: ClaimedKeyPackages['keyPackages'] = [];
      const missing: ClaimedKeyPackages['missing'] = [];
      for (const d of devices) {
        const keyPackage = claimed.get(d.deviceId);
        if (keyPackage) keyPackages.push({ ...d, keyPackage });
        else missing.push(d);
      }
      return { keyPackages, missing };
    });
  }

  async getGroup(userId: string, conversationId: string): Promise<{ group: E2eeGroup | null }> {
    this.requireEnabled();
    await this.requireMember(conversationId, userId);
    const row = await findE2eeGroup(this.db, conversationId);
    return { group: row ? toGroup(row) : null };
  }

  /** Records the conversation's group and the creator's welcomes. Only the first creator wins:
   *  a second device that raced it gets a 409 and waits for its own welcome instead. */
  async createGroup(
    userId: string,
    conversationId: string,
    input: CreateE2eeGroupInput,
  ): Promise<E2eeGroup> {
    await this.requireDevice(userId, input.deviceId);
    await this.requireDirectConversation(conversationId, userId);
    return this.db.transaction(async (tx) => {
      const row = await insertE2eeGroup(tx, conversationId, input.deviceId);
      if (!row) throw new ConflictException('This conversation already has an encryption group');
      const allowed = new Set(
        (await listMemberDevices(tx, conversationId, input.deviceId)).map((d) => d.deviceId),
      );
      const recipients = new Set<string>();
      for (const w of input.welcomes) {
        if (!allowed.has(w.deviceId) || recipients.has(w.deviceId)) {
          throw new BadRequestException('A welcome is addressed to a device outside this chat');
        }
        recipients.add(w.deviceId);
      }
      await insertWelcomes(tx, conversationId, input.deviceId, input.welcomes);
      return toGroup(row);
    });
  }

  async welcomes(userId: string, deviceId: string): Promise<{ welcomes: E2eeWelcome[] }> {
    await this.requireDevice(userId, deviceId);
    const rows = await listWelcomes(this.db, deviceId);
    return {
      welcomes: rows.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        senderDeviceId: r.senderDeviceId,
        welcome: r.welcome,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async deleteWelcome(userId: string, id: string): Promise<void> {
    this.requireEnabled();
    if (!(await deleteWelcome(this.db, id, userId))) throw new NotFoundException('Not found');
  }

  /** Used by the send path: encrypted messages need the flag and an existing group. */
  async assertCanSendEncrypted(conversationId: string): Promise<void> {
    if (!this.enabled) throw new BadRequestException('Encrypted messages are not enabled');
    const basics = await findConversationBasics(this.db, conversationId);
    if (basics?.type !== 'direct') {
      throw new BadRequestException('Encrypted messages are only available in direct chats');
    }
    if (!(await findE2eeGroup(this.db, conversationId))) {
      throw new BadRequestException('This chat has no encryption group yet');
    }
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new NotFoundException('Not found');
  }

  private async requireDevice(userId: string, deviceId: string): Promise<void> {
    this.requireEnabled();
    if (!(await isActiveDeviceOf(this.db, deviceId, userId))) {
      throw new ForbiddenException('Unknown device');
    }
  }

  private async requireMember(conversationId: string, userId: string): Promise<void> {
    if (!(await isConversationMember(this.db, conversationId, userId))) {
      throw new NotFoundException('Conversation not found');
    }
  }

  private async requireDirectConversation(conversationId: string, userId: string): Promise<void> {
    await this.requireMember(conversationId, userId);
    const basics = await findConversationBasics(this.db, conversationId);
    if (basics?.type !== 'direct') {
      throw new BadRequestException('The encryption prototype supports direct chats only');
    }
  }
}

function toGroup(row: E2eeGroupRow): E2eeGroup {
  return {
    conversationId: row.conversationId,
    creatorDeviceId: row.creatorDeviceId,
    createdAt: row.createdAt.toISOString(),
  };
}
