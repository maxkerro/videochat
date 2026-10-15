import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  SEARCH_PAGE_SIZE,
  searchTerms,
  type SearchQuery,
  type SearchResponse,
} from '@videochat/shared';
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  memberships,
  MESSAGE_SEARCH_VECTOR,
  messages,
  users,
  type MessageRow,
} from '../db/schema.js';
import { DB } from '../infra/tokens.js';
import { toMessages } from '../messages/message-mapper.js';

/** `to_tsquery` input: every word must appear, each as a prefix ("budg" finds "budget"). The
 *  words are letters and digits only, so nothing in them is tsquery syntax. */
export function prefixQuery(q: string): string | null {
  const terms = searchTerms(q);
  return terms.length > 0 ? terms.map((t) => `${t}:*`).join(' & ') : null;
}

/** Opaque "after this result" marker: newest first, ties broken by id. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = iso ? new Date(iso) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || !id || !/^[0-9A-Z]{26}$/.test(id)) {
    return null;
  }
  return { createdAt, id };
}

/**
 * CHAT-072: full-text search over the messages (and attachment file names) in conversations the
 * person is a current member of -- nothing else is ever looked at. Newest first, paged by cursor.
 * Uses the GIN index on {@link MESSAGE_SEARCH_VECTOR}.
 */
@Injectable()
export class SearchService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async search(userId: string, query: SearchQuery): Promise<SearchResponse> {
    const tsquery = prefixQuery(query.q);
    if (!tsquery) return { results: [], nextCursor: null };
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw new BadRequestException('Invalid cursor');

    const q = sql`to_tsquery('simple'::regconfig, ${tsquery})`;
    const where: SQL[] = [
      sql`${MESSAGE_SEARCH_VECTOR} @@ ${q}`,
      isNull(messages.deletedAt),
      inArray(messages.type, ['text', 'image', 'file']),
    ];
    if (query.conversationId) where.push(eq(messages.conversationId, query.conversationId));
    if (query.from) where.push(eq(messages.senderId, query.from));
    if (query.after) where.push(sql`${messages.createdAt} >= ${new Date(query.after)}`);
    if (query.before) where.push(lt(messages.createdAt, new Date(query.before)));
    if (query.has === 'file') where.push(sql`${messages.meta} ? 'attachment'`);
    if (query.has === 'image') where.push(eq(messages.type, 'image'));
    if (cursor) {
      where.push(
        or(
          lt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        message: messages,
        senderName: users.displayName,
        snippet: sql<string>`ts_headline('simple'::regconfig,
          coalesce(nullif(${messages.body}, ''), ${messages.meta}->'attachment'->>'filename', ''),
          ${q},
          ${`StartSel=${SEARCH_MARK_START}, StopSel=${SEARCH_MARK_END}, MaxWords=24, MinWords=8, MaxFragments=1, FragmentDelimiter=" … "`})`,
      })
      .from(messages)
      // Only conversations the person is in right now (`left_at` set = no longer a member).
      .innerJoin(
        memberships,
        and(
          eq(memberships.conversationId, messages.conversationId),
          eq(memberships.userId, userId),
          isNull(memberships.leftAt),
        ),
      )
      .leftJoin(users, eq(users.id, messages.senderId))
      .where(and(...where))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(SEARCH_PAGE_SIZE + 1);

    const page = rows.slice(0, SEARCH_PAGE_SIZE);
    const mapped = await toMessages(
      this.db,
      page.map((r) => r.message as MessageRow),
    );
    const last = page.at(-1)?.message;
    return {
      results: mapped.map((message, i) => ({
        message,
        senderName: page[i]!.senderName ?? null,
        snippet: page[i]!.snippet ?? '',
      })),
      nextCursor:
        rows.length > SEARCH_PAGE_SIZE && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}
