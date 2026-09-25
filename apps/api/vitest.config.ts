import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    // Vitest's default 'threads' pool runs test files inside Node worker_threads. rolldown's
    // native N-API binding (pulled in transitively via vite) fails to load there -- it throws
    // "Cannot find native binding" and falls through to a wasm fallback that also isn't
    // installed, aborting the whole run with "Cannot find module '@rolldown/binding-wasm32-wasi'"
    // -- even though the same binding loads fine in a plain Node process or under this 'forks'
    // pool (child_process-based, no worker_threads involved). Confirmed by direct testing: an
    // absolute-path `import()` of rolldown's entry point succeeds standalone, and apps/web's
    // full suite (20 files / 110 tests) passed cleanly under --pool=forks but failed under the
    // default pool. This isn't specific to this package -- see the matching comment in
    // apps/web/vite.config.ts and packages/shared/vitest.config.ts.
    pool: 'forks',
  },
});
