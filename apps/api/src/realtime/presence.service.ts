import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  makeEnvelope,
  PRESENCE_TTL_SECONDS,
  type LastSeenVisibility,
  type Presence,
} from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Database } from '../db/client.js';
import { getPresenceSettings, listPresenceContacts, setLastActive } from '../db/presence.js';
import { DB, REDIS } from '../infra/tokens.js';
import { RealtimeService } from './realtime.service.js';

const TTL_MS = PRESENCE_TTL_SECONDS * 1000;
const SWEEP_INTERVAL_MS = 15_000;
const ONLINE_KEY = 'presence:online';
const connsKey = (userId: string) => `presence:conns:${userId}`;

/**
 * CHAT-034 visibility rule: `subject`'s presence is visible to `viewer` when the subject allows
 * it (everyone, or contacts = a shared direct conversation) and the viewer doesn't hide their own
 * (AC: "users who hide last seen also can't see others' last seen").
 */
export function canSeePresence(
  subjectVisibility: LastSeenVisibility,
  viewerVisibility: LastSeenVisibility,
  sharesDirect: boolean,
): boolean {
  if (viewerVisibility === 'nobody') return false;
  if (subjectVisibility === 'everyone') return true;
  return subjectVisibility === 'contacts' && sharesDirect;
}

/**
 * CHAT-034: online / last seen, shared across API nodes through Redis.
 *
 * - `presence:conns:{userId}` -- a sorted set of that user's live connection ids, scored by
 *   expiry. Every socket refreshes its entry on the 25 s heartbeat; several tabs and devices are
 *   several entries but one user ("multiple tabs or devices count as one online user").
 * - `presence:online` -- users with any live connection, scored by their latest expiry. The
 *   sweep finds users whose connections all lapsed without a clean close (a crashed node, a
 *   laptop lid closed), so they go offline within 60 s too.
 *
 * Whoever removes a user from `presence:online` (ZREM returns 1 for exactly one caller) owns the
 * offline transition: records last-seen and tells their contacts. Online transitions are
 * announced by the node whose connect found no live connection before it.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private sweepTimer?: NodeJS.Timeout;
  /** Set on shutdown: sockets closing as the app stops mustn't touch Redis after it's gone. */
  private stopping = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    clearInterval(this.sweepTimer);
  }

  async connected(userId: string, connectionId: string, now = Date.now()): Promise<void> {
    try {
      const key = connsKey(userId);
      const [, [, before]] = (await this.redis
        .multi()
        .zremrangebyscore(key, '-inf', now)
        .zcount(key, now, '+inf')
        .zadd(key, now + TTL_MS, connectionId)
        .pexpire(key, TTL_MS * 2)
        .zadd(ONLINE_KEY, 'GT', now + TTL_MS, userId)
        .exec()) as [unknown, [unknown, number], ...unknown[]];
      if (before === 0) await this.announce(userId, { userId, online: true, lastSeenAt: null });
    } catch (err) {
      this.logger.warn(`Presence connect failed: ${(err as Error).message}`);
    }
  }

  /** Called on every heartbeat tick with this node's live connections. */
  async refresh(entries: Array<{ userId: string; connectionId: string }>, now = Date.now()) {
    if (!entries.length || this.stopping) return;
    try {
      const multi = this.redis.multi();
      for (const { userId, connectionId } of entries) {
        multi.zadd(connsKey(userId), now + TTL_MS, connectionId);
        multi.pexpire(connsKey(userId), TTL_MS * 2);
        multi.zadd(ONLINE_KEY, 'GT', now + TTL_MS, userId);
      }
      await multi.exec();
    } catch (err) {
      this.logger.warn(`Presence refresh failed: ${(err as Error).message}`);
    }
  }

  async disconnected(userId: string, connectionId: string, now = Date.now()): Promise<void> {
    if (this.stopping) return;
    try {
      const key = connsKey(userId);
      await this.redis.zrem(key, connectionId);
      const live = await this.redis.zcount(key, now, '+inf');
      if (live === 0) await this.goOffline(userId, new Date(now));
    } catch (err) {
      this.logger.warn(`Presence disconnect failed: ${(err as Error).message}`);
    }
  }

  /** Users whose every connection lapsed without a clean disconnect. */
  async sweep(now = Date.now()): Promise<void> {
    try {
      const expired = await this.redis.zrangebyscore(ONLINE_KEY, '-inf', now);
      for (const userId of expired) {
        const live = await this.redis.zcount(connsKey(userId), now, '+inf');
        if (live > 0) continue; // a refresh landed meanwhile
        await this.redis.zremrangebyscore(connsKey(userId), '-inf', now);
        await this.goOffline(userId, new Date(now - TTL_MS));
      }
    } catch (err) {
      this.logger.warn(`Presence sweep failed: ${(err as Error).message}`);
    }
  }

  /** CHAT-034: presence of `userIds` as `viewerId` may see it; ids they share no conversation
   *  with, or aren't allowed to see, are left out. */
  async getForViewer(viewerId: string, userIds: string[], now = Date.now()): Promise<Presence[]> {
    const ids = userIds.filter((id) => id !== viewerId);
    const [contacts, settings] = await Promise.all([
      listPresenceContacts(this.db, viewerId, ids),
      getPresenceSettings(this.db, [viewerId, ...ids]),
    ]);
    const viewerVisibility = settings.get(viewerId)?.visibility ?? 'everyone';
    const visible = contacts.filter((c) =>
      canSeePresence(c.visibility, viewerVisibility, c.sharesDirect),
    );
    if (!visible.length) return [];
    const multi = this.redis.multi();
    for (const c of visible) multi.zcount(connsKey(c.userId), now, '+inf');
    const counts = ((await multi.exec()) ?? []).map(([, n]) => Number(n ?? 0));
    return visible.map((c, i) => {
      const online = counts[i]! > 0;
      const last = settings.get(c.userId)?.lastActiveAt ?? null;
      return { userId: c.userId, online, lastSeenAt: online || !last ? null : last.toISOString() };
    });
  }

  private async goOffline(userId: string, at: Date): Promise<void> {
    const owned = await this.redis.zrem(ONLINE_KEY, userId);
    if (owned !== 1) return;
    await setLastActive(this.db, userId, at);
    await this.announce(userId, { userId, online: false, lastSeenAt: at.toISOString() });
  }

  /** Tells each contact allowed to see it. */
  private async announce(userId: string, presence: Presence): Promise<void> {
    const [contacts, settings] = await Promise.all([
      listPresenceContacts(this.db, userId),
      getPresenceSettings(this.db, [userId]),
    ]);
    const subjectVisibility = settings.get(userId)?.visibility ?? 'everyone';
    const envelope = makeEnvelope('presence.changed', presence, randomUUID());
    await Promise.all(
      contacts
        // `c.visibility` here is the *viewer's* own setting.
        .filter((c) => canSeePresence(subjectVisibility, c.visibility, c.sharesDirect))
        .map((c) => this.realtime.publishToUser(c.userId, envelope)),
    );
  }
}
