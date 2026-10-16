import type { ClaimedKeyPackages, E2eeGroup, E2eeWelcome, Message } from '@videochat/shared';
import type { E2eeApi } from './api';
import { E2eeClient, E2eeUnavailableError } from './client';
import { createMemoryStore, type E2eeStore } from './store';

/**
 * CHAT-076 (spike): the real MLS flow (ts-mls) between devices, against an in-memory stand-in for
 * the key directory with the same rules as the API (one-time key packages, first group wins).
 */
function createFakeDirectory(members: Record<string, string[]>) {
  const devices = new Map<string, string>(); // deviceId -> userId
  const packages = new Map<string, string[]>();
  const lastResorts = new Map<string, string>();
  const revoked = new Set<string>();
  const groups = new Map<string, E2eeGroup>();
  const welcomes: (E2eeWelcome & { to: string })[] = [];
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

  function apiFor(userId: string): E2eeApi {
    return {
      registerDevice: async () => {
        const deviceId = uuid();
        devices.set(deviceId, userId);
        packages.set(deviceId, []);
        return { deviceId };
      },
      keyPackageCount: async (deviceId) => {
        if (revoked.has(deviceId)) throw new Error('unknown device');
        return packages.get(deviceId)!.length;
      },
      revokeDevice: async (deviceId) => {
        revoked.add(deviceId);
        packages.set(deviceId, []);
        lastResorts.delete(deviceId);
      },
      revokeOtherDevices: async (deviceId) => {
        let count = 0;
        for (const [id, owner] of devices) {
          if (owner === userId && id !== deviceId && !revoked.has(id)) {
            revoked.add(id);
            count++;
          }
        }
        return count;
      },
      isUnknownDevice: (error) => error instanceof Error && error.message === 'unknown device',
      uploadKeyPackages: async (deviceId, kps, lastResort) => {
        packages.get(deviceId)!.push(...kps);
        if (lastResort) lastResorts.set(deviceId, lastResort);
      },
      claim: async (conversationId, deviceId) => {
        const out: ClaimedKeyPackages = { keyPackages: [], missing: [] };
        for (const [id, owner] of devices) {
          if (id === deviceId || revoked.has(id) || !members[conversationId]!.includes(owner)) {
            continue;
          }
          const kp = packages.get(id)!.shift();
          const fallback = lastResorts.get(id);
          if (kp) out.keyPackages.push({ userId: owner, deviceId: id, keyPackage: kp });
          else if (fallback) {
            out.keyPackages.push({
              userId: owner,
              deviceId: id,
              keyPackage: fallback,
              lastResort: true,
            });
          } else out.missing.push({ userId: owner, deviceId: id });
        }
        return out;
      },
      getGroup: async (conversationId) => groups.get(conversationId) ?? null,
      createGroup: async (conversationId, deviceId, list) => {
        if (groups.has(conversationId)) return false;
        groups.set(conversationId, {
          conversationId,
          creatorDeviceId: deviceId,
          createdAt: new Date().toISOString(),
        });
        for (const w of list) {
          welcomes.push({
            id: uuid(),
            to: w.deviceId,
            conversationId,
            senderDeviceId: deviceId,
            welcome: w.welcome,
            createdAt: new Date().toISOString(),
          });
        }
        return true;
      },
      welcomes: async (deviceId) => welcomes.filter((w) => w.to === deviceId),
      deleteWelcome: async (id) => {
        const i = welcomes.findIndex((w) => w.id === id);
        if (i >= 0) welcomes.splice(i, 1);
      },
    };
  }
  return { apiFor, packages, revoked };
}

const ANNA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';

let seq = 0;
const asMessage = (conversationId: string, e2ee: Message['e2ee']) => ({
  id: `01J00000000000000000000${String(++seq).padStart(3, '0')}`,
  conversationId,
  e2ee,
});

describe('E2eeClient (CHAT-076 spike)', () => {
  function setUp() {
    const directory = createFakeDirectory({ [DM]: [ANNA, BEN] });
    const device = (userId: string, store: E2eeStore = createMemoryStore()) =>
      new E2eeClient(userId, directory.apiFor(userId), store);
    return { directory, device };
  }

  it('encrypts a DM so every device of the other person can read it, and back', async () => {
    const { device } = setUp();
    const anna = device(ANNA);
    const benPhone = device(BEN);
    const benLaptop = device(BEN);
    await Promise.all([anna.device(), benPhone.device(), benLaptop.device()]);

    const payload = await anna.encrypt(DM, 'Hello Ben 🔐');
    expect(payload.v).toBe(1);
    expect(atob(payload.ciphertext)).not.toContain('Hello');
    const msg = asMessage(DM, payload);
    await anna.rememberSent(msg.id, 'Hello Ben 🔐');

    expect(await benPhone.decrypt(msg)).toEqual({ status: 'ok', text: 'Hello Ben 🔐' });
    expect(await benLaptop.decrypt(msg)).toEqual({ status: 'ok', text: 'Hello Ben 🔐' });
    // Decrypted once; afterwards it comes from the local store (MLS keys are single use).
    expect(await benPhone.decrypt(msg)).toEqual({ status: 'ok', text: 'Hello Ben 🔐' });
    expect(await anna.decrypt(msg)).toEqual({ status: 'ok', text: 'Hello Ben 🔐' });

    const reply = asMessage(DM, await benLaptop.encrypt(DM, 'Hi Anna'));
    expect(await anna.decrypt(reply)).toEqual({ status: 'ok', text: 'Hi Anna' });
    // Ben's other device reads what his laptop sent, too.
    expect(await benPhone.decrypt(reply)).toEqual({ status: 'ok', text: 'Hi Anna' });

    const members = await anna.members(DM);
    expect(members?.map((m) => m.userId).sort()).toEqual([ANNA, BEN, BEN]);
  }, 20_000);

  it('keeps working after a reload (state restored from the store)', async () => {
    const { device } = setUp();
    const annaStore = createMemoryStore();
    const benStore = createMemoryStore();
    const anna = device(ANNA, annaStore);
    const ben = device(BEN, benStore);
    await Promise.all([anna.device(), ben.device()]);
    const first = asMessage(DM, await anna.encrypt(DM, 'one'));
    expect(await ben.decrypt(first)).toMatchObject({ text: 'one' });

    const annaAgain = device(ANNA, annaStore);
    const benAgain = device(BEN, benStore);
    expect((await annaAgain.device()).deviceId).toBe((await anna.device()).deviceId);
    const second = asMessage(DM, await annaAgain.encrypt(DM, 'two'));
    expect(await benAgain.decrypt(second)).toMatchObject({ text: 'two' });
    expect(await benAgain.decrypt(first)).toMatchObject({ text: 'one' });
  }, 20_000);

  it('settles a race: both sides create a group, one wins and both still talk', async () => {
    const { device } = setUp();
    const anna = device(ANNA);
    const ben = device(BEN);
    await Promise.all([anna.device(), ben.device()]);
    const [a, b] = await Promise.allSettled([
      anna.encrypt(DM, 'from anna'),
      ben.encrypt(DM, 'from ben'),
    ]);
    // The loser either joined the winner's group in time or must wait for the next try.
    const sent = [a, b].filter((r) => r.status === 'fulfilled');
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const later = asMessage(DM, await ben.encrypt(DM, 'again'));
    expect(await anna.decrypt(later)).toMatchObject({ text: 'again' });
    const back = asMessage(DM, await anna.encrypt(DM, 'ok'));
    expect(await ben.decrypt(back)).toMatchObject({ text: 'ok' });
  }, 20_000);

  it('refuses to encrypt until the other person has a device, and says why', async () => {
    const { device } = setUp();
    const anna = device(ANNA);
    await expect(anna.encrypt(DM, 'hello?')).rejects.toBeInstanceOf(E2eeUnavailableError);
  }, 20_000);

  it('reports messages it cannot read instead of throwing', async () => {
    const { device } = setUp();
    const anna = device(ANNA);
    const ben = device(BEN);
    await Promise.all([anna.device(), ben.device()]);
    const sent = asMessage(DM, await anna.encrypt(DM, 'secret'));
    await ben.decrypt(sent);
    // A device that joined later (here: a brand-new store) can't read older messages.
    const benNewDevice = device(BEN);
    await benNewDevice.device();
    expect(await benNewDevice.decrypt(sent)).toEqual({ status: 'waiting' });
    // Garbage ciphertext is a failure, not a crash.
    expect(await ben.decrypt(asMessage(DM, { v: 1, ciphertext: 'AAAA' }))).toEqual({
      status: 'failed',
    });
  }, 20_000);

  it('serialises two tabs of the same browser sharing one store (Web Locks)', async () => {
    const queues = new Map<string, Promise<unknown>>();
    const locks = {
      request: <T>(name: string, cb: () => Promise<T>) => {
        const run = (queues.get(name) ?? Promise.resolve()).then(cb);
        queues.set(
          name,
          run.catch(() => undefined),
        );
        return run;
      },
    };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    try {
      const { device } = setUp();
      const annaStore = createMemoryStore();
      const tabA = device(ANNA, annaStore);
      const tabB = device(ANNA, annaStore);
      const ben = device(BEN);
      await ben.device();
      const [a, b] = await Promise.all([tabA.device(), tabB.device()]);
      expect(a.deviceId).toBe(b.deviceId);
      const first = asMessage(DM, await tabA.encrypt(DM, 'first'));
      expect(await ben.decrypt(first)).toMatchObject({ text: 'first' });
      const [x, y] = await Promise.all([
        tabA.encrypt(DM, 'from tab A'),
        tabB.encrypt(DM, 'from tab B'),
      ]);
      expect(await ben.decrypt(asMessage(DM, x))).toEqual({ status: 'ok', text: 'from tab A' });
      expect(await ben.decrypt(asMessage(DM, y))).toEqual({ status: 'ok', text: 'from tab B' });
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  }, 20_000);

  it('refuses a Welcome to a "DM" group that holds a third person', async () => {
    const CLARA = '44444444-4444-4444-8444-444444444444';
    const directory = createFakeDirectory({ [DM]: [ANNA, BEN, CLARA] });
    const make = (userId: string) =>
      new E2eeClient(userId, directory.apiFor(userId), createMemoryStore());
    const [anna, ben, clara] = [make(ANNA), make(BEN), make(CLARA)];
    await Promise.all([anna.device(), ben.device(), clara.device()]);
    const sent = asMessage(DM, await anna.encrypt(DM, 'hello'));
    expect(await ben.decrypt(sent)).toEqual({ status: 'waiting' });
    expect(await ben.members(DM)).toBeNull();
  }, 20_000);

  it('joins through the last-resort key package when the one-time ones are gone', async () => {
    const { directory, device } = setUp();
    const anna = device(ANNA);
    const ben = device(BEN);
    const benDevice = await ben.device();
    await anna.device();
    directory.packages.set(benDevice.deviceId, []); // drained by someone else
    const sent = asMessage(DM, await anna.encrypt(DM, 'still works'));
    expect(await ben.decrypt(sent)).toEqual({ status: 'ok', text: 'still works' });
  }, 20_000);

  it('forgets this browser: device removed on the server, local keys and texts wiped', async () => {
    const { directory, device } = setUp();
    const store = createMemoryStore();
    const anna = device(ANNA, store);
    const ben = device(BEN);
    await ben.device();
    const first = await anna.device();
    const sent = asMessage(DM, await anna.encrypt(DM, 'hi'));
    await anna.rememberSent(sent.id, 'hi');
    await anna.forget();
    expect(directory.revoked.has(first.deviceId)).toBe(true);
    expect(await store.getDevice(ANNA)).toBeUndefined();
    expect(await store.getPlaintext(sent.id)).toBeUndefined();
    expect(await store.getGroup(DM)).toBeUndefined();
    // Turning it back on registers a new device.
    expect((await anna.device()).deviceId).not.toBe(first.deviceId);
  }, 20_000);

  it('starts over as a new device after being removed from another one', async () => {
    const { device } = setUp();
    const laptopStore = createMemoryStore();
    const laptop = device(ANNA, laptopStore);
    const phone = device(ANNA);
    const old = await laptop.device();
    await phone.device();
    expect(await phone.removeOtherDevices()).toBe(1);
    const reopened = device(ANNA, laptopStore); // the laptop's next page load
    expect((await reopened.device()).deviceId).not.toBe(old.deviceId);
  }, 20_000);
});
