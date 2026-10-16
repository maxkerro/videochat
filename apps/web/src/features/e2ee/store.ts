/**
 * CHAT-076 (spike): where a device keeps its secrets. Private keys, MLS group state and the
 * decrypted text never leave the device. Uint8Arrays are stored as-is (IndexedDB clones them).
 */
export interface StoredDevice {
  userId: string;
  deviceId: string;
  /** The current last-resort key package (its ref) and when it was made; the one before it is
   *  kept until the next rotation, for welcomes that were already on their way. */
  lastResort?: { ref: string; createdAt: number; previousRef?: string };
}

export interface StoredKeyPackage {
  /** Hex KeyPackageRef: how a Welcome names the key package it was made for. */
  ref: string;
  /** The TLS-encoded public KeyPackage message. */
  publicBytes: Uint8Array;
  privateKeys: {
    initPrivateKey: Uint8Array;
    hpkePrivateKey: Uint8Array;
    signaturePrivateKey: Uint8Array;
  };
  /** The device's reusable last-resort package: never deleted after a join. */
  lastResort?: boolean;
}

export interface E2eeStore {
  getDevice(userId: string): Promise<StoredDevice | undefined>;
  putDevice(device: StoredDevice): Promise<void>;
  putKeyPackages(packages: StoredKeyPackage[]): Promise<void>;
  getKeyPackage(ref: string): Promise<StoredKeyPackage | undefined>;
  deleteKeyPackage(ref: string): Promise<void>;
  /** Encoded MLS GroupState for a conversation. */
  getGroup(conversationId: string): Promise<Uint8Array | undefined>;
  putGroup(conversationId: string, state: Uint8Array): Promise<void>;
  /** Decrypted text by message id (MLS keys are single use, so this is the only copy). */
  getPlaintext(messageId: string): Promise<string | undefined>;
  putPlaintext(messageId: string, text: string): Promise<void>;
  /** Wipes everything: the device, its keys, group states and decrypted text. */
  clear(): Promise<void>;
}

export function createMemoryStore(): E2eeStore {
  const devices = new Map<string, StoredDevice>();
  const packages = new Map<string, StoredKeyPackage>();
  const groups = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  return {
    getDevice: async (userId) => devices.get(userId),
    putDevice: async (d) => void devices.set(d.userId, d),
    putKeyPackages: async (list) => list.forEach((p) => packages.set(p.ref, p)),
    getKeyPackage: async (ref) => packages.get(ref),
    deleteKeyPackage: async (ref) => void packages.delete(ref),
    getGroup: async (id) => groups.get(id),
    putGroup: async (id, s) => void groups.set(id, s),
    getPlaintext: async (id) => texts.get(id),
    putPlaintext: async (id, t) => void texts.set(id, t),
    clear: async () => {
      devices.clear();
      packages.clear();
      groups.clear();
      texts.clear();
    },
  };
}

const DB_PREFIX = 'videochat-e2ee';
const STORES = ['devices', 'keyPackages', 'groups', 'plaintexts'] as const;
type StoreName = (typeof STORES)[number];

/** IndexedDB-backed store for browsers: one database per account in this browser profile, so a
 *  second account signed in here never sees the first one's keys or messages. */
export function createIndexedDbStore(userId: string): E2eeStore {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`${DB_PREFIX}-${userId}`, 1);
      req.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Failed to open the encryption store'));
    }));

  async function run<T>(
    name: StoreName,
    mode: IDBTransactionMode,
    op: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const req = op(tx.objectStore(name));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error ?? new Error('Encryption store error'));
    });
  }
  const get = <T>(name: StoreName, key: string) =>
    run<T | undefined>(name, 'readonly', (s) => s.get(key));
  const put = (name: StoreName, key: string, value: unknown) =>
    run<unknown>(name, 'readwrite', (s) => s.put(value, key)).then(() => undefined);

  return {
    getDevice: (userId) => get('devices', userId),
    putDevice: (d) => put('devices', d.userId, d),
    putKeyPackages: async (list) => {
      for (const p of list) await put('keyPackages', p.ref, p);
    },
    getKeyPackage: (ref) => get('keyPackages', ref),
    deleteKeyPackage: (ref) =>
      run<unknown>('keyPackages', 'readwrite', (s) => s.delete(ref)).then(() => undefined),
    getGroup: (id) => get('groups', id),
    putGroup: (id, state) => put('groups', id, state),
    getPlaintext: (id) => get('plaintexts', id),
    putPlaintext: (id, text) => put('plaintexts', id, text),
    clear: async () => {
      for (const name of STORES) {
        await run<unknown>(name, 'readwrite', (st) => st.clear());
      }
    },
  };
}
