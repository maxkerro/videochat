import * as SQLite from 'expo-sqlite';
import { migrate } from './schema';
import { createSerializedDb, type RawDb } from './sql';
import { createLocalStore, type LocalStore } from './store';

let opened: Promise<LocalStore> | null = null;

/** The app's one local store, opened (and migrated) on first use. */
export function getLocalStore(): Promise<LocalStore> {
  opened ??= (async () => {
    const native = await SQLite.openDatabaseAsync('chat.db');
    await native.execAsync('PRAGMA journal_mode = WAL');
    const raw: RawDb = {
      exec: (sql) => native.execAsync(sql),
      run: async (sql, params = []) => {
        await native.runAsync(sql, params);
      },
      all: <T>(sql: string, params: (string | number | null)[] = []) =>
        native.getAllAsync<T>(sql, params),
    };
    const db = createSerializedDb(raw);
    await migrate(db);
    return createLocalStore(db);
  })();
  // A failed open must not be cached forever.
  opened.catch(() => {
    opened = null;
  });
  return opened;
}
