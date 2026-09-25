#!/usr/bin/env node
// Used by .githooks/pre-push before it runs `pnpm test`: confirms the local
// Postgres and Redis that the e2e suites need are actually reachable, not
// just configured.
//
// `hasInfra` in apps/api/test/helpers.ts (`describe.skipIf(!hasInfra)`) only
// checks that TEST_DATABASE_URL/REDIS_URL are *set* -- it can't tell a real
// running service from a stale .env pointing at a container that was never
// started, or was stopped since. Either way the e2e suites silently skip and
// `pnpm test` reports a false green, which is exactly the kind of gap this
// hook exists to close. This script fails loudly instead, with a pointer to
// `pnpm infra:up`.
//
// Reads apps/api/.env directly (the same file apps/api/test/setup.ts loads
// for the test run itself) rather than relying on these vars already being
// in the shell's environment, since they usually aren't outside of that file.

import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';

function loadEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

const fileEnv = loadEnvFile('apps/api/.env');

function resolve(key, defaultPort) {
  const raw = fileEnv[key] ?? process.env[key];
  if (!raw) return { key, missing: true };
  const url = new URL(raw);
  return { key, host: url.hostname, port: Number(url.port) || defaultPort };
}

const targets = [resolve('TEST_DATABASE_URL', 5432), resolve('REDIS_URL', 6379)];

const missing = targets.filter((t) => t.missing).map((t) => t.key);
if (missing.length > 0) {
  console.error(
    `[check-infra] ${missing.join(', ')} not set in apps/api/.env (cp .env.example apps/api/.env first).`,
  );
  process.exit(2);
}

function probe(target) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: target.host, port: target.port, timeout: 1500 });
    const finish = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const results = await Promise.all(targets.map((t) => probe(t).then((ok) => ({ ...t, ok }))));
const unreachable = results.filter((r) => !r.ok);

if (unreachable.length > 0) {
  for (const r of unreachable) {
    console.error(`[check-infra] ${r.key} (${r.host}:${r.port}) is not reachable.`);
  }
  console.error('[check-infra] Start local infra first: pnpm infra:up');
  process.exit(1);
}

process.exit(0);
