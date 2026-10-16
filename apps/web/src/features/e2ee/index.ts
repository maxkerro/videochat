import { LIMITS, e2eeStatusSchema, type Message, type SendMessageInput } from '@videochat/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiGet } from '../../lib/api';
import { useAuth, withAuthRetry, type AuthContextValue } from '../auth/AuthContext';
import { sendMessage } from '../chat/messagesApi';
import { createHttpE2eeApi } from './api';
import { E2eeClient, E2eeUnavailableError, type DecryptResult } from './client';
import { onSignOut } from '../../lib/signOutHooks';
import { isE2eeEnabled, setE2eeEnabled, subscribeE2eeFlag } from './flag';
import { createIndexedDbStore } from './store';

export { E2eeUnavailableError, isE2eeEnabled };

type AuthLike = Pick<AuthContextValue, 'accessToken' | 'refresh'>;

/** The latest auth state, for requests the client makes on its own (welcomes, key top-ups). */
let latestAuth: AuthLike | undefined;
let current: { userId: string; client: E2eeClient } | undefined;

/** This browser's E2EE client for `userId`, or null while the prototype is off here. */
export function getE2eeClient(userId: string | undefined): E2eeClient | null {
  if (!userId || !isE2eeEnabled() || typeof indexedDB === 'undefined') return null;
  if (current?.userId !== userId) {
    const api = createHttpE2eeApi((fn) => {
      if (!latestAuth) throw new E2eeUnavailableError('Not signed in');
      return withAuthRetry(latestAuth, fn);
    });
    current = { userId, client: new E2eeClient(userId, api, createIndexedDbStore(userId)) };
  }
  return current.client;
}

/**
 * Turns the prototype off in this browser: the device is removed on the server and its keys,
 * group states and decrypted messages are wiped (they can't be decrypted again anyway).
 */
export async function turnOffE2ee(auth: AuthLike & { user?: { id: string } | null }) {
  latestAuth = auth;
  const client = getE2eeClient(auth.user?.id);
  setE2eeEnabled(false);
  current = undefined;
  const result = client ? await client.forget() : null;
  // The keys are gone either way; if the server didn't hear about it, try again next time this
  // person signs in here, so the device doesn't linger as one others can still add to chats.
  if (result && !result.revoked && auth.user) {
    addPendingRevoke({ userId: auth.user.id, deviceId: result.deviceId });
  }
}

// Signing out does the same, so the next person on a shared computer finds nothing. The opt-in
// is per person, so it's switched off too.
onSignOut(async ({ userId, accessToken, refresh }) => {
  if (!isE2eeEnabled()) return;
  await turnOffE2ee({ accessToken, refresh, user: { id: userId } });
});

const PENDING_KEY = 'videochat:e2ee-pending-revokes';
type PendingRevoke = { userId: string; deviceId: string };

function readPending(): PendingRevoke[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as PendingRevoke[]) : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingRevoke[]): void {
  try {
    if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage blocked: the device just drops out after 30 days instead.
  }
}

function addPendingRevoke(entry: PendingRevoke): void {
  writePending([...readPending().filter((p) => p.deviceId !== entry.deviceId), entry]);
}

/** Removes, on the server, devices this browser wiped while signed out or offline. */
export async function flushPendingRevokes(auth: AuthLike & { user?: { id: string } | null }) {
  const userId = auth.user?.id;
  const mine = readPending().filter((p) => p.userId === userId);
  if (!userId || mine.length === 0) return;
  const api = createHttpE2eeApi((fn) => withAuthRetry(auth, fn));
  for (const p of mine) {
    const done = await api.revokeDevice(p.deviceId).then(
      () => true,
      (error: unknown) => api.isUnknownDevice(error),
    );
    if (done) writePending(readPending().filter((x) => x.deviceId !== p.deviceId));
  }
}

export function useE2eeFlag(): boolean {
  return useSyncExternalStore(subscribeE2eeFlag, isE2eeEnabled, () => false);
}

/** The client while the prototype is on in this browser (null otherwise). */
export function useE2ee(): E2eeClient | null {
  const auth = useAuth();
  const enabled = useE2eeFlag();
  useEffect(() => {
    latestAuth = auth;
  }, [auth]);
  // Once per signed-in person (a token refresh doesn't need another pass).
  const flushedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = auth.user?.id;
    if (!auth.accessToken || !id || flushedFor.current === id) return;
    flushedFor.current = id;
    void flushPendingRevokes(auth).catch(() => undefined);
  }, [auth]);
  const client = enabled ? getE2eeClient(auth.user?.id) : null;
  // Register this browser as soon as the prototype is on, so others can add it to chats before
  // it ever sends anything itself.
  useEffect(() => {
    if (client) void client.device().catch(() => undefined);
  }, [client]);
  return client;
}

/** Whether the server has the prototype switched on (for the Settings toggle). */
export function useE2eeServerStatus(): boolean {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['e2ee-status'],
    enabled: !!auth.accessToken,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      withAuthRetry(auth, (token) =>
        apiGet('/e2ee/status', e2eeStatusSchema, { headers: { Authorization: `Bearer ${token}` } }),
      ),
  });
  return query.data?.enabled ?? false;
}

/**
 * Sends a text message, encrypted when `encrypted` (the chat is a DM and the prototype is on).
 * The plain text is kept on this device: a sender can't decrypt its own MLS message.
 */
export async function sendTextMessage(
  auth: AuthLike & { user?: { id: string } | null },
  conversationId: string,
  input: Omit<SendMessageInput, 'e2ee'> & { body: string },
  encrypted: boolean,
) {
  if (!encrypted) return withAuthRetry(auth, (token) => sendMessage(token, conversationId, input));
  latestAuth = auth;
  const client = getE2eeClient(auth.user?.id);
  if (!client) throw new E2eeUnavailableError('Encryption is off in this browser');
  const payload = await client.encrypt(conversationId, input.body);
  const message = await withAuthRetry(auth, (token) =>
    sendMessage(token, conversationId, {
      clientMsgId: input.clientMsgId,
      e2ee: payload,
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
    }),
  );
  await client.rememberSent(message.id, input.body);
  return message;
}

export const ENCRYPTED_PLACEHOLDER = '🔒 Encrypted message';

function labelFor(result: DecryptResult | undefined, enabled: boolean): string {
  if (!enabled) return ENCRYPTED_PLACEHOLDER;
  if (!result) return '🔒 Decrypting…';
  if (result.status === 'ok') return result.text;
  if (result.status === 'waiting') return '🔒 Waiting for this chat’s encryption keys…';
  return '🔒 This message can’t be decrypted on this device';
}

const RETRY_WAITING_MS = 3_000;

/**
 * Messages with each encrypted one's `body` replaced by its decrypted text (or a status line),
 * so the rest of the chat UI renders them like any other message.
 */
export function useDecryptedMessages(client: E2eeClient | null, messages: Message[]): Message[] {
  const [results, setResults] = useState<ReadonlyMap<string, DecryptResult>>(new Map());
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!client) return;
    for (const m of messages) {
      if (!m.e2ee || m.deletedAt || requested.current.has(m.id)) continue;
      requested.current.add(m.id);
      // The client is shared and remembers results, so a result that lands after this effect
      // re-ran (new messages arrived) is still worth keeping.
      void client.decrypt(m).then((result) => {
        if (mounted.current) setResults((prev) => new Map(prev).set(m.id, result));
      });
    }
  }, [client, messages, retryTick]);

  // Messages that arrived before this device's Welcome: ask again shortly.
  useEffect(() => {
    const waiting = [...results].filter(([, r]) => r.status === 'waiting').map(([id]) => id);
    if (waiting.length === 0) return;
    const timer = setTimeout(() => {
      waiting.forEach((id) => requested.current.delete(id));
      setRetryTick((t) => t + 1);
    }, RETRY_WAITING_MS);
    return () => clearTimeout(timer);
  }, [results]);

  return useMemo(
    () =>
      messages.map((m) => {
        let out = m;
        if (m.e2ee && !m.deletedAt) out = { ...out, body: labelFor(results.get(m.id), !!client) };
        // A reply to an encrypted message quotes this device's own decrypted copy, if it has one.
        const quoted = m.replyTo?.encrypted ? results.get(m.replyTo.id) : undefined;
        if (m.replyTo && quoted?.status === 'ok') {
          const snippet =
            quoted.text.length > LIMITS.replySnippetLength
              ? `${quoted.text.slice(0, LIMITS.replySnippetLength)}…`
              : quoted.text;
          out = { ...out, replyTo: { ...m.replyTo, snippet } };
        }
        return out;
      }),
    [messages, results, client],
  );
}
