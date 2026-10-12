/**
 * CHAT-053: the smallest SQL surface the local store needs. The app implements it with expo-sqlite
 * (`expoDb.ts`); the tests implement it with Node's built-in SQLite, so the real SQL is exercised
 * without a phone.
 */
export type SqlValue = string | number | null;

export interface RawDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

export interface SqlDb extends RawDb {
  /** Runs `fn` in one transaction; nothing else touches the connection until it finishes. */
  transaction<T>(fn: (tx: RawDb) => Promise<T>): Promise<T>;
}

/**
 * Wraps a connection so that every call (and every whole transaction) runs strictly one after
 * another. A single SQLite connection interleaves statements from concurrent callers, which would
 * pull a stray write into someone else's transaction or let a rollback undo it.
 */
export function createSerializedDb(raw: RawDb): SqlDb {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    exec: (sql) => serial(() => raw.exec(sql)),
    run: (sql, params) => serial(() => raw.run(sql, params)),
    all: <T>(sql: string, params?: SqlValue[]) => serial(() => raw.all<T>(sql, params)),
    transaction: <T>(fn: (tx: RawDb) => Promise<T>) =>
      serial(async () => {
        await raw.exec('BEGIN');
        try {
          const result = await fn(raw);
          await raw.exec('COMMIT');
          return result;
        } catch (e) {
          await raw.exec('ROLLBACK').catch(() => undefined);
          throw e;
        }
      }),
  };
}
