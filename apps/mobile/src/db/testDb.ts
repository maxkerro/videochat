import { DatabaseSync } from 'node:sqlite';
import { createSerializedDb, type SqlDb, type SqlValue } from './sql';
import { migrate } from './schema';

/** Test helper: the real SQL schema and queries on Node's built-in SQLite (in memory). */
export async function createTestDb(): Promise<SqlDb> {
  const native = new DatabaseSync(':memory:');
  const db = createSerializedDb({
    exec: (sql) => {
      native.exec(sql);
      return Promise.resolve();
    },
    run: (sql, params: SqlValue[] = []) => {
      native.prepare(sql).run(...params);
      return Promise.resolve();
    },
    all: <T>(sql: string, params: SqlValue[] = []) =>
      Promise.resolve(native.prepare(sql).all(...params) as T[]),
  });
  await migrate(db);
  return db;
}
