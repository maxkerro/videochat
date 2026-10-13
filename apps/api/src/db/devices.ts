import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import { devices, refreshTokens, users } from './schema.js';

export interface PushDevice {
  id: string;
  userId: string;
  platform: 'web' | 'ios' | 'android';
  token: string;
  keys: { p256dh: string; auth: string } | null;
}

/** CHAT-035: saves a web push subscription for `userId`. The endpoint is unique per browser
 *  profile; if it was registered by someone else on this browser before, it moves to this user. */
export async function upsertWebPushDevice(
  db: DbExecutor,
  userId: string,
  endpoint: string,
  keys: { p256dh: string; auth: string },
  userAgent: string | null,
): Promise<void> {
  await db
    .insert(devices)
    .values({ userId, platform: 'web', pushToken: endpoint, pushKeys: keys, userAgent })
    .onConflictDoUpdate({
      target: devices.pushToken,
      targetWhere: sql`${devices.pushToken} IS NOT NULL`,
      set: { userId, pushKeys: keys, userAgent, lastSeenAt: sql`now()` },
    });
}

/** CHAT-055: saves a phone's native push token for `userId`. A token is unique per app install;
 *  if someone else was signed in on this phone before, it moves to this user. */
export async function upsertNativePushDevice(
  db: DbExecutor,
  userId: string,
  platform: 'ios' | 'android',
  token: string,
  userAgent: string | null,
  sessionFamilyId: string,
): Promise<void> {
  await db
    .insert(devices)
    .values({ userId, platform, pushToken: token, pushKeys: null, userAgent, sessionFamilyId })
    .onConflictDoUpdate({
      target: devices.pushToken,
      targetWhere: sql`${devices.pushToken} IS NOT NULL`,
      set: { userId, platform, pushKeys: null, userAgent, sessionFamilyId, lastSeenAt: sql`now()` },
    });
}

export async function deletePushDevice(
  db: DbExecutor,
  endpoint: string,
  userId?: string,
): Promise<void> {
  await db
    .delete(devices)
    .where(and(eq(devices.pushToken, endpoint), ...(userId ? [eq(devices.userId, userId)] : [])));
}

/**
 * The push-capable devices of these users. A phone is bound to the login session it registered
 * under (CHAT-055), so it only counts while that session still has a live refresh token: a session
 * that expired (or was revoked in a race with its registration) never gets another preview, even
 * though nothing deleted its row. Browsers (no session binding) are always listed.
 */
export async function listPushDevices(db: DbExecutor, userIds: string[]): Promise<PushDevice[]> {
  if (!userIds.length) return [];
  const sessionLive = sql`EXISTS (
    SELECT 1 FROM ${refreshTokens}
    WHERE ${refreshTokens.familyId} = ${devices.sessionFamilyId}
      AND ${refreshTokens.revokedAt} IS NULL
      AND ${refreshTokens.expiresAt} > now()
  )`;
  const rows = await db
    .select()
    .from(devices)
    .where(
      and(
        inArray(devices.userId, userIds),
        isNotNull(devices.pushToken),
        or(isNull(devices.sessionFamilyId), sessionLive),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    platform: r.platform,
    token: r.pushToken!,
    keys: r.pushKeys ?? null,
  }));
}

/** CHAT-037: notification settings of these users (deleted accounts never notify). */
export async function getNotificationPrefs(
  db: DbExecutor,
  userIds: string[],
): Promise<Map<string, { enabled: boolean; sound: boolean; previews: boolean }>> {
  const map = new Map<string, { enabled: boolean; sound: boolean; previews: boolean }>();
  if (!userIds.length) return map;
  const rows = await db
    .select({
      id: users.id,
      enabled: users.notifyEnabled,
      sound: users.notifySound,
      previews: users.notifyPreviews,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(inArray(users.id, userIds));
  for (const r of rows) {
    map.set(r.id, { enabled: r.enabled && !r.deletedAt, sound: r.sound, previews: r.previews });
  }
  return map;
}
