import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    // Bumped from 20s: on a loaded dev machine (heavy background VMs, memory pressure,
    // Spotlight reindexing after a fresh install, etc.) an individual request can stall for
    // several seconds waiting on the OS to schedule the process again -- confirmed to be host
    // contention, not an app bug or a real hang, since the same request always completes once
    // the host catches up and CPU sits at 0% the whole time it's stalled. 30s gives more
    // headroom to absorb that without masking a genuine deadlock.
    testTimeout: 30_000,
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
