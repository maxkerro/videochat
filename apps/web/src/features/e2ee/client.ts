import { E2EE, type E2eePayload, type Message } from '@videochat/shared';
import type { ClientState } from 'ts-mls';
import type { E2eeApi } from './api';
// The MLS code (ts-mls and its crypto) loads only once a browser actually uses the prototype.
const loadMls = () => import('./mls');
import type { E2eeStore, StoredDevice } from './store';

/**
 * CHAT-076 (spike): one device's end-to-end encryption, for direct chats.
 *
 * - The device registers with the key directory and uploads one-time key packages.
 * - The first device to send in a chat creates its MLS group, adding one key package of every
 *   other device in the chat, and leaves each of them a Welcome.
 * - Every other device joins from its Welcome the first time it needs the group.
 * - Text is encrypted before it's sent and decrypted once on arrival; the plain text is kept
 *   locally, because MLS deletes message keys after use.
 *
 * Not in the prototype (see the design doc): devices added after the group exists, removing
 * devices, groups, attachments, and verifying safety numbers.
 */

export type DecryptResult =
  | { status: 'ok'; text: string }
  /** No group on this device yet (its Welcome hasn't arrived), or the message is still pending. */
  | { status: 'waiting' }
  /** This device can't decrypt it (it joined later, or its keys were lost). */
  | { status: 'failed' };

export class E2eeUnavailableError extends Error {}

const KEY_PACKAGE_BATCH = 10;
const KEY_PACKAGE_LOW_WATER = 5;

export class E2eeClient {
  private devicePromise: Promise<StoredDevice> | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<string, Promise<DecryptResult>>();

  constructor(
    readonly userId: string,
    private readonly api: E2eeApi,
    private readonly store: E2eeStore,
  ) {}

  /** This browser's device, registering it (and uploading key packages) the first time. */
  device(): Promise<StoredDevice> {
    // Locked across tabs too: two tabs opening at once must not register two devices.
    this.devicePromise ??= this.withLock('device', () => this.loadOrRegister()).catch(
      (error: unknown) => {
        this.devicePromise = undefined;
        throw error;
      },
    );
    return this.devicePromise;
  }

  /** Encrypts `text` for the chat, creating or joining its group first if needed. */
  encrypt(conversationId: string, text: string): Promise<E2eePayload> {
    return this.withLock(conversationId, async () => {
      const mls = await loadMls();
      const state = await this.groupFor(conversationId, { create: true });
      if (!state) throw new E2eeUnavailableError('This chat is waiting for its encryption keys');
      const out = await mls.encryptText(state, text);
      await this.store.putGroup(conversationId, mls.encodeState(out.state));
      return { v: E2EE.payloadVersion, ciphertext: mls.toBase64(out.ciphertext) };
    });
  }

  /** Records what this device sent: a device can't decrypt its own MLS messages. */
  rememberSent(messageId: string, text: string): Promise<void> {
    return this.store.putPlaintext(messageId, text);
  }

  /** The text of an encrypted message, decrypting it at most once. */
  decrypt(message: Pick<Message, 'id' | 'conversationId' | 'e2ee'>): Promise<DecryptResult> {
    const running = this.inflight.get(message.id);
    if (running) return running;
    const task = this.decryptOnce(message).finally(() => this.inflight.delete(message.id));
    this.inflight.set(message.id, task);
    return task;
  }

  /** The devices in this chat's group (`userId:deviceId`), or null without a group yet. */
  async members(conversationId: string): Promise<{ userId: string; deviceId: string }[] | null> {
    const mls = await loadMls();
    const bytes = await this.store.getGroup(conversationId);
    return bytes ? mls.groupMembers(mls.decodeState(bytes)) : null;
  }

  private async decryptOnce(
    message: Pick<Message, 'id' | 'conversationId' | 'e2ee'>,
  ): Promise<DecryptResult> {
    const cached = await this.store.getPlaintext(message.id);
    if (cached !== undefined) return { status: 'ok', text: cached };
    if (!message.e2ee) return { status: 'failed' };
    const payload = message.e2ee;
    return this.withLock(message.conversationId, async () => {
      const mls = await loadMls();
      const again = await this.store.getPlaintext(message.id);
      if (again !== undefined) return { status: 'ok', text: again };
      const state = await this.groupFor(message.conversationId, { create: false });
      if (!state) return { status: 'waiting' };
      try {
        const out = await mls.decryptText(state, mls.fromBase64(payload.ciphertext));
        await this.store.putGroup(message.conversationId, mls.encodeState(out.state));
        if (out.text === null) return { status: 'failed' };
        await this.store.putPlaintext(message.id, out.text);
        return { status: 'ok', text: out.text };
      } catch {
        return { status: 'failed' };
      }
    });
  }

  /** The chat's group state: stored, else joined from a waiting Welcome, else (when `create`)
   *  created now. Null when another device owns the group and our Welcome hasn't come. */
  private async groupFor(
    conversationId: string,
    { create }: { create: boolean },
  ): Promise<ClientState | null> {
    const mls = await loadMls();
    const stored = await this.store.getGroup(conversationId);
    if (stored) return mls.decodeState(stored);
    await this.acceptWelcomes();
    const joined = await this.store.getGroup(conversationId);
    if (joined) return mls.decodeState(joined);
    if (!create || (await this.api.getGroup(conversationId))) return null;
    return this.createGroup(conversationId);
  }

  private async createGroup(conversationId: string): Promise<ClientState | null> {
    const mls = await loadMls();
    const device = await this.device();
    const claimed = await this.api.claim(conversationId, device.deviceId);
    // The key directory says whose key package is whose; check the package agrees, so the server
    // can't pass off one device's key as another's.
    const others = claimed.keyPackages.filter((k) => {
      const id = mls.parseIdentity(mls.keyPackageIdentity(mls.fromBase64(k.keyPackage)));
      return id?.userId === k.userId.toLowerCase() && id.deviceId === k.deviceId.toLowerCase();
    });
    if (!others.some((k) => k.userId !== this.userId)) {
      throw new E2eeUnavailableError('The other person hasn’t turned on encryption yet');
    }
    const own = await mls.newKeyPackage(mls.identityFor(this.userId, device.deviceId));
    const { state, welcome } = await mls.createGroupWith(
      conversationId,
      own,
      others.map((k) => mls.fromBase64(k.keyPackage)),
    );
    const welcomeB64 = welcome ? mls.toBase64(welcome) : null;
    const won = await this.api.createGroup(
      conversationId,
      device.deviceId,
      welcomeB64 ? others.map((k) => ({ deviceId: k.deviceId, welcome: welcomeB64 })) : [],
    );
    if (!won) {
      // Another device created the group first: ours is thrown away, theirs arrives as a Welcome.
      await this.acceptWelcomes();
      const theirs = await this.store.getGroup(conversationId);
      return theirs ? mls.decodeState(theirs) : null;
    }
    await this.store.putGroup(conversationId, mls.encodeState(state));
    return state;
  }

  /** Joins every group this device has a Welcome for. */
  private acceptWelcomes(): Promise<void> {
    return this.withLock('welcomes', async () => {
      const mls = await loadMls();
      const device = await this.device();
      for (const w of await this.api.welcomes(device.deviceId)) {
        try {
          const bytes = mls.fromBase64(w.welcome);
          let own;
          for (const ref of mls.welcomeRefs(bytes)) {
            own = await this.store.getKeyPackage(ref);
            if (own) break;
          }
          if (own && !(await this.store.getGroup(w.conversationId))) {
            const { state, groupId } = await mls.joinWithWelcome(bytes, own);
            // The group must be this chat's, include us, and (a DM) hold no more than one other
            // person. Which devices are in it is still the server directory's word: safety-number
            // verification is what would catch a planted device of the other person.
            const users = new Set(mls.groupMembers(state).map((m) => m.userId));
            if (groupId === w.conversationId && users.has(this.userId) && users.size <= 2) {
              await this.store.putGroup(w.conversationId, mls.encodeState(state));
              await this.store.deleteKeyPackage(own.ref);
            }
          }
        } catch {
          // A Welcome we can't use (not ours, or corrupt) is dropped below either way.
        }
        await this.api.deleteWelcome(w.id);
      }
    });
  }

  private async loadOrRegister(): Promise<StoredDevice> {
    const existing = await this.store.getDevice(this.userId);
    if (existing) {
      void this.topUp(existing).catch(() => undefined);
      return existing;
    }
    const { deviceId } = await this.api.registerDevice();
    const device = { userId: this.userId, deviceId };
    await this.store.putDevice(device);
    await this.uploadKeyPackages(device);
    return device;
  }

  private async topUp(device: StoredDevice): Promise<void> {
    if ((await this.api.keyPackageCount(device.deviceId)) < KEY_PACKAGE_LOW_WATER) {
      await this.uploadKeyPackages(device);
    }
  }

  private async uploadKeyPackages(device: StoredDevice): Promise<void> {
    const mls = await loadMls();
    const identity = mls.identityFor(device.userId, device.deviceId);
    const batch = await Promise.all(
      Array.from({ length: KEY_PACKAGE_BATCH }, () => mls.newKeyPackage(identity)),
    );
    // Private halves first: a key package must never be claimable before we can use it.
    await this.store.putKeyPackages(batch);
    await this.api.uploadKeyPackages(
      device.deviceId,
      batch.map((k) => mls.toBase64(k.publicBytes)),
    );
  }

  /**
   * Runs `fn` alone for `key`: queued behind earlier calls in this tab, and -- through the Web
   * Locks API -- behind other tabs of this browser, which share the same IndexedDB state. Two tabs
   * encrypting from the same stored group state would reuse a ratchet generation and roll the
   * state back over keys that should be gone.
   */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    const run = locks
      ? () => locks.request(`videochat-e2ee:${this.userId}:${key}`, () => fn())
      : fn;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }
}
