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
import { E2EE, E2EE_UNKNOWN_DEVICE } from '@videochat/shared';
import type { Env } from '../config/env.js';
import { directConversationsWithBlock, hasBlockInDirectConversation } from '../db/blocks.js';
import type { Database } from '../db/client.js';
import { findConversationBasics, isConversationMember } from '../db/conversations.js';
import {
  addKeyPackages,
  claimKeyPackages,
  countActiveDevices,
  countKeyPackages,
  createE2eeDevice,
  deleteWelcome,
  findE2eeGroup,
  insertE2eeGroup,
  insertWelcomes,
  findDeviceState,
  listMemberDevices,
  listWelcomes,
  lockUserDevices,
  revokeDevices,
  touchDevice,
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

  /** At most `E2EE.maxDevicesPerUser` active devices per account: each one can hold key
   *  packages, and a chat's group has to fit every device of both people. */
  async registerDevice(userId: string): Promise<E2eeDevice> {
    this.requireEnabled();
    return this.db.transaction(async (tx) => {
      await lockUserDevices(tx, userId);
      if ((await countActiveDevices(tx, userId)) >= E2EE.maxDevicesPerUser) {
        throw new ConflictException(
          `You can use encryption on up to ${E2EE.maxDevicesPerUser} devices`,
        );
      }
      return { deviceId: await createE2eeDevice(tx, userId), userId };
    });
  }

  async uploadKeyPackages(
    userId: string,
    deviceId: string,
    keyPackages: string[],
    lastResort?: string,
  ): Promise<{ count: number }> {
    await this.requireDevice(userId, deviceId);
    return this.db.transaction(async (tx) => ({
      count: await addKeyPackages(tx, deviceId, keyPackages, lastResort),
    }));
  }

  /** Removes one of the caller's devices (e.g. this browser turning encryption off). */
  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    this.requireEnabled();
    const n = await this.db.transaction((tx) => revokeDevices(tx, userId, { deviceId }));
    if (n === 0) throw new NotFoundException('Not found');
  }

  /** Removes every device of the caller except `deviceId` (lost phones, old browsers). */
  async revokeOtherDevices(userId: string, deviceId: string): Promise<{ revoked: number }> {
    await this.requireDevice(userId, deviceId);
    return {
      revoked: await this.db.transaction((tx) =>
        revokeDevices(tx, userId, { allExcept: deviceId }),
      ),
    };
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
      // Key packages are one-time: only hand them out while a group can still be created, and
      // never across a block either way (that would only drain the other person's keys).
      if (await hasBlockInDirectConversation(tx, conversationId, userId)) {
        throw new ForbiddenException('Encryption isn’t available in this chat');
      }
      if (await findE2eeGroup(tx, conversationId)) {
        throw new ConflictException('This conversation already has an encryption group');
      }
      const devices = await listMemberDevices(tx, conversationId, deviceId);
      const claimed = await claimKeyPackages(
        tx,
        devices.map((d) => d.deviceId),
      );
      const keyPackages: ClaimedKeyPackages['keyPackages'] = [];
      const missing: ClaimedKeyPackages['missing'] = [];
      for (const d of devices) {
        const got = claimed.get(d.deviceId);
        if (got) {
          keyPackages.push({
            ...d,
            keyPackage: got.keyPackage,
            ...(got.lastResort ? { lastResort: true } : {}),
          });
        } else missing.push(d);
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
      if (await hasBlockInDirectConversation(tx, conversationId, userId)) {
        throw new ForbiddenException('Encryption isn’t available in this chat');
      }
      const row = await insertE2eeGroup(tx, conversationId, input.deviceId);
      if (!row) throw new ConflictException('This conversation already has an encryption group');
      const owners = new Map(
        (await listMemberDevices(tx, conversationId, input.deviceId)).map((d) => [
          d.deviceId,
          d.userId,
        ]),
      );
      const recipients = new Set<string>();
      for (const w of input.welcomes) {
        if (!owners.has(w.deviceId) || recipients.has(w.deviceId)) {
          throw new BadRequestException('A welcome is addressed to a device outside this chat');
        }
        recipients.add(w.deviceId);
      }
      // A group the other person can't join would lock the chat out of encryption for good.
      if (![...recipients].some((id) => owners.get(id) !== userId)) {
        throw new BadRequestException('The group must include the other person’s devices');
      }
      await insertWelcomes(tx, conversationId, input.deviceId, input.welcomes);
      return toGroup(row);
    });
  }

  async welcomes(userId: string, deviceId: string): Promise<{ welcomes: E2eeWelcome[] }> {
    await this.requireDevice(userId, deviceId);
    const all = await listWelcomes(this.db, deviceId);
    // Nothing new across a block: the chat stays as it was when the block started.
    const blocked = await directConversationsWithBlock(
      this.db,
      all.map((r) => r.conversationId),
      userId,
    );
    const rows = all.filter((r) => !blocked.has(r.conversationId));
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

  /**
   * The device must belong to the caller and not be removed. One that went quiet for
   * `E2EE.inactiveDeviceDays` comes back only if the account is under its device limit (it no
   * longer counted, so a newer device may have taken its place); otherwise it's unknown and the
   * browser starts over as a new device.
   */
  private async requireDevice(userId: string, deviceId: string): Promise<void> {
    this.requireEnabled();
    const state = await findDeviceState(this.db, deviceId, userId);
    if (state === 'current') {
      await touchDevice(this.db, deviceId);
      return;
    }
    if (state === 'inactive') {
      const revived = await this.db.transaction(async (tx) => {
        await lockUserDevices(tx, userId);
        if ((await countActiveDevices(tx, userId)) >= E2EE.maxDevicesPerUser) return false;
        await touchDevice(tx, deviceId, { force: true });
        return true;
      });
      if (revived) return;
    }
    throw new ForbiddenException({ message: 'Unknown device', code: E2EE_UNKNOWN_DEVICE });
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
