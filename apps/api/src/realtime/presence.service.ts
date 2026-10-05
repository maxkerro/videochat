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

/** Whether someone with `visibility` shares their presence with a person they do / don't have a
 *  direct conversation with. */
function shares(visibility: LastSeenVisibility, sharesDirect: boolean): boolean {
  return visibility === 'everyone' || (visibility === 'contacts' && sharesDirect);
}

/**
 * CHAT-034 visibility rule, reciprocal: `viewer` sees `subject`'s presence only when each would
 * share their own with the other. So the subject must allow it (everyone, or contacts = a shared
 * direct conversation), and a viewer who hides their own presence from someone can't see that
 * person's either -- "nobody" sees no one, "contacts" sees only contacts (AC: "users who hide last
 * seen also can't see others' last seen", applied per level, as WhatsApp does). Blocks hide it
 * both ways before this rule runs (`listPresenceContacts`).
 */
export function canSeePresence(
  subjectVisibility: LastSeenVisibility,
  viewerVisibility: LastSeenVisibility,
  sharesDirect: boolean,
): boolean {
  return shares(subjectVisibility, sharesDirect) && shares(viewerVisibility, sharesDirect);
}

/**
 * Atomically drops one connection and, if that leaves the user with no live one, takes them out
 * of `presence:online`. Returns 1 when this call made the user go offline. One script, so a
 * reconnect (whose `connected` MULTI is atomic too) lands wholly before or after it -- never
 * between "count is zero" and "remove from online".
 * KEYS: conns, online. ARGV: connectionId, now, userId.
 */
const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCOUNT', KEYS[1], ARGV[2], '+inf') > 0 then return 0 end
return redis.call('ZREM', KEYS[2], ARGV[3])
`;

/**
 * The sweep's counterpart: if the user has no live connection, clears the lapsed ones and takes
 * them out of `presence:online`, returning their latest expiry (their online score) so last-seen
 * can be the last refresh rather than the sweep time. Returns false if they're still live or
 * someone else already took them offline.
 * KEYS: conns, online. ARGV: now, userId.
 */
const SWEEP_SCRIPT = `
if redis.call('ZCOUNT', KEYS[1], ARGV[1], '+inf') > 0 then return false end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local score = redis.call('ZSCORE', KEYS[2], ARGV[2])
if not score then return false end
redis.call('ZREM', KEYS[2], ARGV[2])
return score
`;

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
 * Whoever removes a user from `presence:online` owns the offline transition: records last-seen
 * and tells their contacts. That removal happens in the same Lua script as the "no live
 * connection left" check, so a reconnect can't slip in between. Online transitions are announced
 * by the node whose connect found no live connection before it. The two announcements come from
 * different code paths and can still reach a contact out of order (the offline one waits on a DB
 * write), so after announcing offline the owner re-checks and re-announces online if the user is
 * back -- the last word a contact gets is always the current state.
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
      const wentOffline = await this.redis.eval(
        RELEASE_SCRIPT,
        2,
        connsKey(userId),
        ONLINE_KEY,
        connectionId,
        now,
        userId,
      );
      if (wentOffline === 1) await this.announceOffline(userId, new Date(now));
    } catch (err) {
      this.logger.warn(`Presence disconnect failed: ${(err as Error).message}`);
    }
  }

  /** Users whose every connection lapsed without a clean disconnect. */
  async sweep(now = Date.now()): Promise<void> {
    try {
      const expired = await this.redis.zrangebyscore(ONLINE_KEY, '-inf', now);
      for (const userId of expired) {
        const score = (await this.redis.eval(
          SWEEP_SCRIPT,
          2,
          connsKey(userId),
          ONLINE_KEY,
          now,
          userId,
        )) as string | null;
        if (score === null) continue; // a refresh landed meanwhile, or someone else got there
        // The score is the last refresh's expiry; the refresh itself was one TTL earlier.
        await this.announceOffline(userId, new Date(Number(score) - TTL_MS));
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

  /** The owner of an offline transition: record last seen, tell contacts, then re-announce online
   *  if a reconnect raced us (its "online" may have reached contacts before our "offline"). */
  private async announceOffline(userId: string, at: Date): Promise<void> {
    await setLastActive(this.db, userId, at);
    await this.announce(userId, { userId, online: false, lastSeenAt: at.toISOString() });
    if ((await this.redis.zcount(connsKey(userId), Date.now(), '+inf')) > 0) {
      await this.announce(userId, { userId, online: true, lastSeenAt: null });
    }
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
