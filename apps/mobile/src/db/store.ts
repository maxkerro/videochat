import {
  conversationSummarySchema,
  messageSchema,
  type ConversationSummary,
  type Message,
} from '@videochat/shared';
import type { z } from 'zod';
import type { SqlDb } from './sql';

/** CHAT-053 AC: "Cache size is capped (e.g. last 500 messages per conversation)". */
export const MAX_MESSAGES_PER_CONVERSATION = 500;

export interface OutboxItem {
  clientMsgId: string;
  conversationId: string;
  body: string;
  replyToId: string | null;
  queuedAt: number;
  /** `queued`: waiting to be sent. `failed`: the server refused it -- the person decides. */
  state: 'queued' | 'failed';
  error: string | null;
}

interface OutboxRow {
  client_msg_id: string;
  conversation_id: string;
  body: string;
  reply_to_id: string | null;
  queued_at: number;
  state: 'queued' | 'failed';
  error: string | null;
}

const toOutboxItem = (r: OutboxRow): OutboxItem => ({
  clientMsgId: r.client_msg_id,
  conversationId: r.conversation_id,
  body: r.body,
  replyToId: r.reply_to_id,
  queuedAt: r.queued_at,
  state: r.state,
  error: r.error,
});

/** Rows that no longer match the schema (the API changed since they were cached) are skipped, not
 *  fatal: the next fetch replaces them. */
function parseRows<T>(rows: { json: string }[], schema: z.ZodType<T>): T[] {
  const out: T[] = [];
  for (const row of rows) {
    try {
      const parsed = schema.safeParse(JSON.parse(row.json));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // corrupt row: ignore
    }
  }
  return out;
}

/**
 * CHAT-053: the on-device copy of conversations, recent messages and the offline outbox. It is a
 * cache -- the server stays the source of truth -- except for the outbox, which holds messages the
 * server has not seen yet and so is the one table that must never be dropped silently.
 */
export function createLocalStore(db: SqlDb, options: { maxMessagesPerConversation?: number } = {}) {
  const cap = options.maxMessagesPerConversation ?? MAX_MESSAGES_PER_CONVERSATION;

  return {
    /** The account the cached rows belong to, so a different account never sees them. */
    getOwner: async (): Promise<string | null> => {
      const [row] = await db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'owner'");
      return row?.value ?? null;
    },
    setOwner: (userId: string) =>
      db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('owner', ?)", [userId]),

    /** Replaces the whole inbox with the server's current list, keeping its order. */
    saveConversations: (list: ConversationSummary[]) =>
      db.transaction(async (tx) => {
        await tx.run('DELETE FROM conversations');
        for (const [ord, c] of list.entries()) {
          await tx.run('INSERT INTO conversations (id, ord, json) VALUES (?, ?, ?)', [
            c.id,
            ord,
            JSON.stringify(c),
          ]);
        }
        // Conversations that left the list (removed from a group, deleted) take their cached
        // messages with them.
        await tx.run(
          'DELETE FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations)',
        );
      }),
    upsertConversation: (c: ConversationSummary) =>
      db.transaction(async (tx) => {
        const [existing] = await tx.all<{ ord: number }>(
          'SELECT ord FROM conversations WHERE id = ?',
          [c.id],
        );
        const [min] = await tx.all<{ ord: number | null }>(
          'SELECT MIN(ord) AS ord FROM conversations',
        );
        const ord = existing?.ord ?? (min?.ord ?? 0) - 1; // a new conversation goes on top
        await tx.run('INSERT OR REPLACE INTO conversations (id, ord, json) VALUES (?, ?, ?)', [
          c.id,
          ord,
          JSON.stringify(c),
        ]);
      }),
    loadConversations: async (): Promise<ConversationSummary[]> =>
      parseRows(
        await db.all<{ json: string }>('SELECT json FROM conversations ORDER BY ord ASC'),
        conversationSummarySchema,
      ),
    removeConversation: (id: string) =>
      db.transaction(async (tx) => {
        await tx.run('DELETE FROM conversations WHERE id = ?', [id]);
        await tx.run('DELETE FROM messages WHERE conversation_id = ?', [id]);
      }),

    /** Adds or updates messages, then trims the conversation to its newest `cap`. */
    saveMessages: (conversationId: string, messages: Message[]) =>
      db.transaction(async (tx) => {
        for (const m of messages) {
          await tx.run(
            'INSERT OR REPLACE INTO messages (conversation_id, id, seq, json) VALUES (?, ?, ?, ?)',
            [conversationId, m.id, m.seq, JSON.stringify(m)],
          );
        }
        await tx.run(
          `DELETE FROM messages WHERE conversation_id = ? AND id NOT IN (
             SELECT id FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?)`,
          [conversationId, conversationId, cap],
        );
      }),
    /** The newest `limit` cached messages, oldest first. */
    loadMessages: async (conversationId: string, limit = 50): Promise<Message[]> =>
      parseRows(
        await db.all<{ json: string }>(
          `SELECT json FROM (
             SELECT json, seq FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?
           ) ORDER BY seq ASC`,
          [conversationId, limit],
        ),
        messageSchema,
      ),

    enqueue: (item: Pick<OutboxItem, 'clientMsgId' | 'conversationId' | 'body' | 'replyToId'>) =>
      db.run(
        `INSERT OR REPLACE INTO outbox (client_msg_id, conversation_id, body, reply_to_id, queued_at, state, error)
         VALUES (?, ?, ?, ?, ?, 'queued', NULL)`,
        [item.clientMsgId, item.conversationId, item.body, item.replyToId, Date.now()],
      ),
    /** Everything unsent, oldest first -- the order the person typed it in. */
    listOutbox: async (conversationId?: string): Promise<OutboxItem[]> => {
      const rows =
        conversationId === undefined
          ? await db.all<OutboxRow>('SELECT * FROM outbox ORDER BY position ASC')
          : await db.all<OutboxRow>(
              'SELECT * FROM outbox WHERE conversation_id = ? ORDER BY position ASC',
              [conversationId],
            );
      return rows.map(toOutboxItem);
    },
    removeFromOutbox: (clientMsgId: string) =>
      db.run('DELETE FROM outbox WHERE client_msg_id = ?', [clientMsgId]),
    markOutboxFailed: (clientMsgId: string, error: string) =>
      db.run("UPDATE outbox SET state = 'failed', error = ? WHERE client_msg_id = ?", [
        error,
        clientMsgId,
      ]),
    /** "Try again" on a failed message: back in the queue, keeping its place. */
    requeueOutbox: (clientMsgId: string) =>
      db.run("UPDATE outbox SET state = 'queued', error = NULL WHERE client_msg_id = ?", [
        clientMsgId,
      ]),

    /** Sign-out: nothing of the account stays on the phone -- unsent messages included, which are
     *  the account's data and must not be sent as (or shown to) whoever logs in next. */
    wipe: () =>
      db.transaction(async (tx) => {
        await tx.run('DELETE FROM conversations');
        await tx.run('DELETE FROM messages');
        await tx.run('DELETE FROM outbox');
        await tx.run('DELETE FROM meta');
      }),
  };
}

export type LocalStore = ReturnType<typeof createLocalStore>;
