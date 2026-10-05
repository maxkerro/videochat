import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { firstUrl, linkPreviewSchema, makeEnvelope, type LinkPreview } from '@videochat/shared';
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Database } from '../db/client.js';
import { isConversationMember } from '../db/conversations.js';
import { findMessage, setMessageLinkPreview } from '../db/messages.js';
import type { MessageRow } from '../db/schema.js';
import { DB, REDIS } from '../infra/tokens.js';
import { toMessage } from '../messages/message-mapper.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { LinkPreviewFetcher } from './link-preview.fetcher.js';

/** AC: cache for 24 h. Pages without a preview (or that failed) are retried after an hour. */
const CACHE_TTL_SEC = 24 * 60 * 60;
const NEGATIVE_TTL_SEC = 60 * 60;
const NONE = 'none';

/**
 * CHAT-031: link previews. A text message with a URL is sent and delivered immediately; the
 * preview is fetched afterwards and added with a `message.updated` event (well within the AC's
 * 2 s for a typical site, and a slow site never delays the message itself). Previews are cached
 * per URL in Redis, shared by every API node.
 */
@Injectable()
export class LinkPreviewsService {
  private readonly logger = new Logger(LinkPreviewsService.name);
  private readonly inflight = new Map<string, Promise<LinkPreview | null>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly realtime: RealtimeService,
    private readonly fetcher: LinkPreviewFetcher,
  ) {}

  /** Preview for a URL from the cache, fetching it on a miss. Null when there's none. */
  async getPreview(url: string): Promise<LinkPreview | null> {
    const key = `linkpreview:${createHash('sha256').update(url).digest('hex')}`;
    const cached = await this.redis.get(key).catch(() => null);
    if (cached === NONE) return null;
    if (cached) {
      const parsed = linkPreviewSchema.safeParse(JSON.parse(cached));
      if (parsed.success) return parsed.data;
    }
    // Several messages with the same link at once share one fetch.
    let pending = this.inflight.get(url);
    if (!pending) {
      pending = this.fetchAndCache(url, key).finally(() => this.inflight.delete(url));
      this.inflight.set(url, pending);
    }
    return pending;
  }

  /** Called after a text message was sent: adds its preview, if it has one, and tells members. */
  async attachToMessage(row: MessageRow): Promise<void> {
    const url = firstUrl(row.body);
    if (!url || row.type !== 'text') return;
    try {
      const preview = await this.getPreview(url);
      if (!preview) return;
      const updated = await setMessageLinkPreview(this.db, row.id, preview, row.body ?? undefined);
      if (!updated) return; // Deleted or edited meanwhile.
      await this.publishUpdated(updated);
    } catch (err) {
      this.logger.warn(`Link preview for message ${row.id} failed: ${(err as Error).message}`);
    }
  }

  /** AC: the sender can dismiss the preview after sending. */
  async removeFromMessage(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const row = await findMessage(this.db, messageId);
    if (
      !row ||
      row.conversationId !== conversationId ||
      !(await isConversationMember(this.db, conversationId, userId))
    ) {
      throw new NotFoundException('Message not found');
    }
    if (row.senderId !== userId) {
      throw new ForbiddenException('Only the sender can remove a link preview');
    }
    if (!row.meta?.linkPreview) return;
    const updated = await setMessageLinkPreview(this.db, messageId, null);
    if (updated) await this.publishUpdated(updated);
  }

  private async publishUpdated(row: MessageRow): Promise<void> {
    await this.realtime.publishToConversation(
      row.conversationId,
      makeEnvelope('message.updated', toMessage(row), randomUUID()),
    );
  }

  private async fetchAndCache(url: string, key: string): Promise<LinkPreview | null> {
    let preview: LinkPreview | null = null;
    try {
      const fetched = await this.fetcher.fetchPreview(url);
      const parsed = fetched ? linkPreviewSchema.safeParse(fetched) : null;
      preview = parsed?.success ? parsed.data : null;
    } catch (err) {
      this.logger.debug(`No preview for ${url}: ${(err as Error).message}`);
    }
    await this.redis
      .set(
        key,
        preview ? JSON.stringify(preview) : NONE,
        'EX',
        preview ? CACHE_TTL_SEC : NEGATIVE_TTL_SEC,
      )
      .catch(() => undefined);
    return preview;
  }
}
