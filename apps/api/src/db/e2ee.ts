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

/** Serialises device registration per account inside the caller's transaction, so the device
 *  cap can't be overshot by parallel requests. */
export async function lockUserDevices(db: DbExecutor, userId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'e2ee-devices:' + userId}))`);
}

export async function countActiveDevices(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(e2eeDevices)
    .where(and(eq(e2eeDevices.userId, userId), isNull(e2eeDevices.revokedAt)));
  return Number(row?.n ?? 0);
}

export async function createE2eeDevice(db: DbExecutor, userId: string): Promise<string> {
  const [row] = await db.insert(e2eeDevices).values({ userId }).returning({ id: e2eeDevices.id });
  return row!.id;
}

/** True when `deviceId` is an active (not removed) device of `userId`. */
export async function isActiveDeviceOf(
  db: DbExecutor,
  deviceId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: e2eeDevices.id })
    .from(e2eeDevices)
    .where(
      and(
        eq(e2eeDevices.id, deviceId),
        eq(e2eeDevices.userId, userId),
        isNull(e2eeDevices.revokedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function countKeyPackages(db: DbExecutor, deviceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(e2eeKeyPackages)
    .where(eq(e2eeKeyPackages.deviceId, deviceId));
  return Number(row?.n ?? 0);
}

/** Adds key packages, keeping at most `E2EE.maxKeyPackagesPerDevice` (the oldest go first). */
export async function addKeyPackages(
  db: DbExecutor,
  deviceId: string,
  keyPackages: string[],
): Promise<number> {
  await db
    .insert(e2eeKeyPackages)
    .values(keyPackages.map((keyPackage) => ({ deviceId, keyPackage })));
  await db.execute(sql`
    DELETE FROM ${e2eeKeyPackages}
    WHERE ${e2eeKeyPackages.deviceId} = ${deviceId}
      AND ${e2eeKeyPackages.id} NOT IN (
        SELECT ${e2eeKeyPackages.id} FROM ${e2eeKeyPackages}
        WHERE ${e2eeKeyPackages.deviceId} = ${deviceId}
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
        isNull(e2eeDevices.revokedAt),
        ne(e2eeDevices.id, exceptDeviceId),
      ),
    )
    .orderBy(asc(e2eeDevices.createdAt));
}

/**
 * Takes (deletes and returns) the oldest key package of each device. `SKIP LOCKED` means two
 * people claiming at once never get the same package: one-time keys stay one-time.
 */
export async function claimKeyPackages(
  db: DbExecutor,
  deviceIds: string[],
): Promise<Map<string, string>> {
  if (deviceIds.length === 0) return new Map();
  const result = await db.execute<{ device_id: string; key_package: string }>(sql`
    DELETE FROM ${e2eeKeyPackages} k
    USING (
      SELECT p.id
      FROM unnest(ARRAY[${sql.join(
        deviceIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]) AS d(device_id)
      CROSS JOIN LATERAL (
        SELECT id FROM ${e2eeKeyPackages}
        WHERE device_id = d.device_id
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ) p
    ) picked
    WHERE k.id = picked.id
    RETURNING k.device_id, k.key_package
  `);
  return new Map(result.rows.map((r) => [r.device_id, r.key_package]));
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
