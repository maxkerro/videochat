import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * CHAT-075: background blur runs MediaPipe's selfie segmentation in the browser. Its WebAssembly
 * runtime (@mediapipe/tasks-vision) is served from this site under /mediapipe/wasm -- not from a
 * third-party CDN at call time: straight from node_modules in dev, copied into the output by a
 * build. The model sits in public/mediapipe (see the README there).
 */
const require = createRequire(import.meta.url);

function assets(): Map<string, string> {
  // (The package's `exports` hide package.json; its entry point sits at the package root.)
  const wasmDir = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
  const files = new Map<string, string>();
  for (const f of readdirSync(wasmDir)) files.set(`mediapipe/wasm/${f}`, join(wasmDir, f));
  return files;
}

const TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.tflite': 'application/octet-stream',
};

export function mediapipeAssets(): Plugin {
  return {
    name: 'videochat-mediapipe-assets',
    configureServer(server) {
      const files = assets();
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
        const file = files.get(path);
        if (!file) return next();
        res.setHeader(
          'Content-Type',
          TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream',
        );
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [fileName, file] of assets()) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(file) });
      }
    },
  };
}
