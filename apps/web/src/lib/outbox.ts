const DB_NAME = 'videochat-outbox';
const DB_VERSION = 1;
const STORE = 'messages';

export interface OutboxMessage {
  /** Also the store's key: a retried enqueue of the same id (shouldn't happen in practice, since
   *  the composer only enqueues once per send) replaces rather than duplicates. */
  clientMsgId: string;
  conversationId: string;
  body: string;
  /** Insertion order, used to flush in the order the person actually typed them (CHAT-017's "sent
   *  in order" requirement) -- `Date.now()` rather than an autoincrement key, since it also lets
   *  {@link listQueuedMessages} report messages oldest-first without a separate index. */
  queuedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'clientMsgId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open outbox database'));
  });
}

/** True in every real browser. False in a test/SSR environment with no IndexedDB, or one where a
 *  privacy setting disables it entirely -- callers degrade to "no offline outbox" rather than
 *  throwing, since queuing offline sends is a resilience feature, not something the composer's
 *  basic send path should depend on. */
function available(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * CHAT-017: the offline outbox. A message the composer couldn't send (because the device is
 * offline, not because the server rejected it) is queued here and flushed, in order, once the
 * realtime connection comes back -- see `RealtimeProvider`'s `flushOutbox`. Idempotent by
 * `clientMsgId` the same way a live retry is, so a message that actually made it to the server
 * just before the connection dropped is never sent twice.
 */
export async function enqueueOutboxMessage(message: OutboxMessage): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(message);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to queue message'));
    });
  } finally {
    db.close();
  }
}

async function getAll(): Promise<OutboxMessage[]> {
  if (!available()) return [];
  const db = await openDb();
  try {
    return await new Promise<OutboxMessage[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as OutboxMessage[]);
      request.onerror = () => reject(request.error ?? new Error('Failed to read outbox'));
    });
  } finally {
    db.close();
  }
}

/** Every queued message for a conversation, oldest-queued first. */
export async function listQueuedMessages(conversationId: string): Promise<OutboxMessage[]> {
  const all = await getAll();
  return all
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

/** Every queued message across every conversation, oldest-queued first -- the order `Realtime
 *  Provider`'s reconnect flush sends them in, so messages go out in the order the person actually
 *  typed them regardless of which conversations they were in. */
export async function listAllQueuedMessages(): Promise<OutboxMessage[]> {
  const all = await getAll();
  return all.sort((a, b) => a.queuedAt - b.queuedAt);
}

/** Removes a message once it's been confirmed sent (or superseded some other way). */
export async function removeOutboxMessage(clientMsgId: string): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(clientMsgId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to remove queued message'));
    });
  } finally {
    db.close();
  }
}
