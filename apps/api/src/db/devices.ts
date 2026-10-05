import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import { devices } from './schema.js';

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

export async function deletePushDevice(
  db: DbExecutor,
  endpoint: string,
  userId?: string,
): Promise<void> {
  await db
    .delete(devices)
    .where(and(eq(devices.pushToken, endpoint), ...(userId ? [eq(devices.userId, userId)] : [])));
}

export async function listPushDevices(db: DbExecutor, userIds: string[]): Promise<PushDevice[]> {
  if (!userIds.length) return [];
  const rows = await db
    .select()
    .from(devices)
    .where(and(inArray(devices.userId, userIds), isNotNull(devices.pushToken)));
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    platform: r.platform,
    token: r.pushToken!,
    keys: r.pushKeys ?? null,
  }));
}
