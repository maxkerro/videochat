import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { E2EE } from '@videochat/shared';
import type { DbExecutor } from './client.js';
import {
  e2eeDevices,
  e2eeGroups,
  e2eeKeyPackages,
  e2eeWelcomes,
  memberships,
  type E2eeGroupRow,
  type E2eeWelcomeRow,
} from './schema.js';

/**
 * CHAT-076 (spike): the end-to-end encryption key directory. Everything stored here is public
 * key material or ciphertext addressed to one device.
 */

/** Not removed, and heard from within `E2EE.inactiveDeviceDays`. */
const deviceIsCurrent = () =>
  and(
    isNull(e2eeDevices.revokedAt),
    sql`${e2eeDevices.lastSeenAt} > now() - make_interval(days => ${E2EE.inactiveDeviceDays})`,
  );

/** Serialises device registration per account inside the caller's transaction, so the device
 *  cap can't be overshot by parallel requests. */
export async function lockUserDevices(db: DbExecutor, userId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'e2ee-devices:' + userId}))`);
}

export async function countActiveDevices(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(e2eeDevices)
    .where(and(eq(e2eeDevices.userId, userId), deviceIsCurrent()));
  return Number(row?.n ?? 0);
}

/** Records that the device is still in use (at most once an hour, to keep writes rare). */
export async function touchDevice(
  db: DbExecutor,
  deviceId: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  await db
    .update(e2eeDevices)
    .set({ lastSeenAt: sql`now()` })
    .where(
      force
        ? eq(e2eeDevices.id, deviceId)
        : and(
            eq(e2eeDevices.id, deviceId),
            sql`${e2eeDevices.lastSeenAt} < now() - interval '1 hour'`,
          ),
    );
}

/** Removes devices of `userId` (one, or all but `keepDeviceId`): they're never added to a group
 *  again, and their key packages and pending welcomes are deleted. Returns how many. */
export async function revokeDevices(
  db: DbExecutor,
  userId: string,
  target: { deviceId: string } | { allExcept: string },
): Promise<number> {
  const rows = await db
    .update(e2eeDevices)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(e2eeDevices.userId, userId),
        isNull(e2eeDevices.revokedAt),
        'deviceId' in target
          ? eq(e2eeDevices.id, target.deviceId)
          : ne(e2eeDevices.id, target.allExcept),
      ),
    )
    .returning({ id: e2eeDevices.id });
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(e2eeKeyPackages).where(inArray(e2eeKeyPackages.deviceId, ids));
    await db.delete(e2eeWelcomes).where(inArray(e2eeWelcomes.recipientDeviceId, ids));
  }
  return ids.length;
}

export async function createE2eeDevice(db: DbExecutor, userId: string): Promise<string> {
  const [row] = await db.insert(e2eeDevices).values({ userId }).returning({ id: e2eeDevices.id });
  return row!.id;
}

/** Whether `deviceId` is a device of `userId`: `current`, `inactive` (quiet for
 *  `E2EE.inactiveDeviceDays`), or `unknown` (not theirs, or removed). */
export async function findDeviceState(
  db: DbExecutor,
  deviceId: string,
  userId: string,
): Promise<'current' | 'inactive' | 'unknown'> {
  const [row] = await db
    .select({ current: sql<boolean>`${deviceIsCurrent()}` })
    .from(e2eeDevices)
    .where(
      and(
        eq(e2eeDevices.id, deviceId),
        eq(e2eeDevices.userId, userId),
        isNull(e2eeDevices.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return 'unknown';
  return row.current ? 'current' : 'inactive';
}

export async function countKeyPackages(db: DbExecutor, deviceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(e2eeKeyPackages)
    .where(and(eq(e2eeKeyPackages.deviceId, deviceId), eq(e2eeKeyPackages.lastResort, false)));
  return Number(row?.n ?? 0);
}

/** Adds one-time key packages, keeping at most `E2EE.maxKeyPackagesPerDevice` (the oldest go
 *  first), and replaces the device's last-resort package when one is given. */
export async function addKeyPackages(
  db: DbExecutor,
  deviceId: string,
  keyPackages: string[],
  lastResort?: string,
): Promise<number> {
  if (keyPackages.length > 0) {
    await db
      .insert(e2eeKeyPackages)
      .values(keyPackages.map((keyPackage) => ({ deviceId, keyPackage })));
  }
  if (lastResort) {
    // One row per device (partial unique index); an upsert, so two parallel uploads can't clash.
    await db
      .insert(e2eeKeyPackages)
      .values({ deviceId, keyPackage: lastResort, lastResort: true })
      .onConflictDoUpdate({
        target: e2eeKeyPackages.deviceId,
        targetWhere: sql`${e2eeKeyPackages.lastResort}`,
        set: { keyPackage: lastResort, createdAt: sql`now()` },
      });
  }
  await db.execute(sql`
    DELETE FROM ${e2eeKeyPackages}
    WHERE ${e2eeKeyPackages.deviceId} = ${deviceId}
      AND NOT ${e2eeKeyPackages.lastResort}
      AND ${e2eeKeyPackages.id} NOT IN (
        SELECT ${e2eeKeyPackages.id} FROM ${e2eeKeyPackages}
        WHERE ${e2eeKeyPackages.deviceId} = ${deviceId} AND NOT ${e2eeKeyPackages.lastResort}
        ORDER BY ${e2eeKeyPackages.createdAt} DESC
        LIMIT ${E2EE.maxKeyPackagesPerDevice}
      )
  `);
  return countKeyPackages(db, deviceId);
}

/** Active devices of the conversation's current members, except `exceptDeviceId`. */
export async function listMemberDevices(
  db: DbExecutor,
  conversationId: string,
  exceptDeviceId: string,
): Promise<{ userId: string; deviceId: string }[]> {
  return db
    .select({ userId: e2eeDevices.userId, deviceId: e2eeDevices.id })
    .from(memberships)
    .innerJoin(e2eeDevices, eq(e2eeDevices.userId, memberships.userId))
    .where(
      and(
        eq(memberships.conversationId, conversationId),
        isNull(memberships.leftAt),
        deviceIsCurrent(),
        ne(e2eeDevices.id, exceptDeviceId),
      ),
    )
    .orderBy(asc(e2eeDevices.createdAt));
}

/**
 * Takes (deletes and returns) the oldest one-time key package of each device. `SKIP LOCKED`
 * means two people claiming at once never get the same one: one-time keys stay one-time. A
 * device with none left gives its last-resort package instead, which stays in place.
 */
export async function claimKeyPackages(
  db: DbExecutor,
  deviceIds: string[],
): Promise<Map<string, { keyPackage: string; lastResort: boolean }>> {
  if (deviceIds.length === 0) return new Map();
  const ids = sql`ARRAY[${sql.join(
    deviceIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  const oneTime = await db.execute<{ device_id: string; key_package: string }>(sql`
    DELETE FROM ${e2eeKeyPackages} k
    USING (
      SELECT p.id
      FROM unnest(${ids}) AS d(device_id)
      CROSS JOIN LATERAL (
        SELECT id FROM ${e2eeKeyPackages}
        WHERE device_id = d.device_id AND NOT last_resort
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ) p
    ) picked
    WHERE k.id = picked.id
    RETURNING k.device_id, k.key_package
  `);
  const out = new Map<string, { keyPackage: string; lastResort: boolean }>(
    oneTime.rows.map((r) => [r.device_id, { keyPackage: r.key_package, lastResort: false }]),
  );
  const rest = deviceIds.filter((id) => !out.has(id));
  if (rest.length > 0) {
    const fallback = await db
      .select({ deviceId: e2eeKeyPackages.deviceId, keyPackage: e2eeKeyPackages.keyPackage })
      .from(e2eeKeyPackages)
      .where(and(inArray(e2eeKeyPackages.deviceId, rest), eq(e2eeKeyPackages.lastResort, true)));
    for (const r of fallback) out.set(r.deviceId, { keyPackage: r.keyPackage, lastResort: true });
  }
  return out;
}

export async function findE2eeGroup(
  db: DbExecutor,
  conversationId: string,
): Promise<E2eeGroupRow | undefined> {
  const [row] = await db
    .select()
    .from(e2eeGroups)
    .where(eq(e2eeGroups.conversationId, conversationId))
    .limit(1);
  return row;
}

/** Returns the new group, or undefined when the conversation already has one. */
export async function insertE2eeGroup(
  db: DbExecutor,
  conversationId: string,
  creatorDeviceId: string,
): Promise<E2eeGroupRow | undefined> {
  const [row] = await db
    .insert(e2eeGroups)
    .values({ conversationId, creatorDeviceId })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function insertWelcomes(
  db: DbExecutor,
  conversationId: string,
  senderDeviceId: string,
  welcomes: { deviceId: string; welcome: string }[],
): Promise<void> {
  if (welcomes.length === 0) return;
  await db.insert(e2eeWelcomes).values(
    welcomes.map((w) => ({
      conversationId,
      senderDeviceId,
      recipientDeviceId: w.deviceId,
      welcome: w.welcome,
    })),
  );
}

export async function listWelcomes(db: DbExecutor, deviceId: string): Promise<E2eeWelcomeRow[]> {
  return db
    .select()
    .from(e2eeWelcomes)
    .where(eq(e2eeWelcomes.recipientDeviceId, deviceId))
    .orderBy(asc(e2eeWelcomes.createdAt))
    .limit(100);
}

/** Deletes a welcome addressed to one of `userId`'s devices. False when there was none. */
export async function deleteWelcome(db: DbExecutor, id: string, userId: string): Promise<boolean> {
  const own = db
    .select({ id: e2eeDevices.id })
    .from(e2eeDevices)
    .where(eq(e2eeDevices.userId, userId));
  const rows = await db
    .delete(e2eeWelcomes)
    .where(and(eq(e2eeWelcomes.id, id), inArray(e2eeWelcomes.recipientDeviceId, own)))
    .returning({ id: e2eeWelcomes.id });
  return rows.length > 0;
}
