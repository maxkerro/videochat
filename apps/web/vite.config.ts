import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    sourcemap: true,
    // ~170 KB gzipped today, mostly react-dom, react-router and zod. Revisit when M1 adds features
    // (route-level splitting, or zod/mini in @videochat/shared).
    chunkSizeWarningLimit: 600,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
    // Vitest's default 'threads' pool runs test files inside Node worker_threads, and rolldown's
    // native N-API binding (pulled in transitively via vite) fails to load there: it throws
    // "Cannot find native binding" and falls through to a wasm fallback that isn't installed
    // either, aborting the whole run with "Cannot find module '@rolldown/binding-wasm32-wasi'" --
    // even though the same binding loads fine in a plain Node process, or under this 'forks' pool
    // (child_process-based, no worker_threads involved). Confirmed directly: an absolute-path
    // `import()` of rolldown's entry point succeeds standalone, and this suite's 20 files / 110
    // tests all passed under --pool=forks but failed under the default pool. See the matching
    // comment in apps/api/vitest.config.ts and packages/shared/vitest.config.ts.
    pool: 'forks',
  },
});
