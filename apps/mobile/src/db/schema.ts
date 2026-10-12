import type { SqlDb } from './sql';

/** Each entry upgrades the database by one version; `PRAGMA user_version` records how far it got. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY NOT NULL,
    ord INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE TABLE messages (
    conversation_id TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (conversation_id, id)
  );
  CREATE INDEX messages_by_seq ON messages (conversation_id, seq);
  CREATE TABLE outbox (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    client_msg_id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    body TEXT NOT NULL,
    reply_to_id TEXT,
    queued_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    error TEXT
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  `,
];

export async function migrate(db: SqlDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    await db.transaction(async (tx) => {
      await tx.exec(MIGRATIONS[version]!);
      await tx.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}
