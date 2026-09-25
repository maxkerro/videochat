import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest's default 'threads' pool runs test files inside Node worker_threads, and rolldown's
    // native N-API binding (pulled in transitively via vite, which vitest uses internally even
    // here where nothing in this package imports vite directly) fails to load there: it throws
    // "Cannot find native binding" and falls through to a wasm fallback that isn't installed
    // either, aborting the whole run with "Cannot find module '@rolldown/binding-wasm32-wasi'" --
    // even though the same binding loads fine in a plain Node process, or under this 'forks' pool
    // (child_process-based, no worker_threads involved). See the matching comment in
    // apps/api/vitest.config.ts and apps/web/vite.config.ts, where this was first diagnosed.
    pool: 'forks',
  },
});
