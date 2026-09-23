# Videochat

A text and video chat app: web first, then iOS and Android.

This repository is a pnpm + Turborepo monorepo:

| Path              | What it is                                                                  |
| ----------------- | --------------------------------------------------------------------------- |
| `apps/api`        | NestJS 12 API (ESM). PostgreSQL via Drizzle ORM, Redis, observability.      |
| `apps/web`        | React 19 + Vite web app. React Router, TanStack Query, Radix UI primitives. |
| `packages/shared` | Types, Zod schemas and constants shared by the API and every client.        |
| `apps/mobile`     | _Arrives in M4_ (React Native / Expo), reusing `packages/shared`.           |

## Getting started

Prerequisites: Node 22.22+, pnpm 10 (`corepack enable`), Docker.

1. `pnpm install`
2. `pnpm infra:up`: starts Postgres, Redis, MinIO and Mailpit in Docker.
3. `cp .env.example apps/api/.env && cp apps/web/.env.example apps/web/.env`
4. `pnpm db:migrate`
5. `pnpm db:seed`: demo users `anna`, `ben`, `clara` (password `password123`), a direct chat and a group chat.
6. `pnpm dev`: API on http://localhost:3000, web on http://localhost:5173, both with hot reload.

Check that everything is connected: http://localhost:3000/health shows `database: up` and `redis: up`, and the web sidebar footer shows **Connected**.

Local tools: MinIO console http://localhost:9001 (`videochat` / `videochat-secret`), Mailpit inbox http://localhost:8025.

## Everyday commands

| Command                                        | Does                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`                                     | Runs API, web and the shared package in watch mode.                         |
| `pnpm test`                                    | Unit tests everywhere, plus API integration tests against `videochat_test`. |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Code quality checks (also run in CI and git hooks).                         |
| `pnpm build`                                   | Production builds of every package.                                         |
| `pnpm db:generate`                             | Creates a new SQL migration after you change `apps/api/src/db/schema.ts`.   |
| `pnpm db:migrate`                              | Applies pending migrations.                                                 |
| `pnpm db:reset`                                | Empties the dev database and re-applies migrations (`-- --empty` to skip).  |
| `pnpm db:seed`                                 | Adds demo data; safe to run repeatedly.                                     |
| `pnpm --filter @videochat/api db:studio`       | Browses the database in Drizzle Studio.                                     |

Git hooks (Husky): `pre-commit` runs ESLint and Prettier on staged files; `pre-push` runs the typecheck.

## How things fit together

- **Shared contract.** API responses and realtime events are described once, as Zod schemas in `packages/shared`. The API returns those types and the web validates responses against the same schemas (`apps/web/src/lib/api.ts`). Change a schema and both sides fail to compile or validate until they agree.
- **Message ordering.** Every message gets a per-conversation `seq` assigned inside the insert transaction (`appendMessage` in `apps/api/src/db/messages.ts`). Clients sync by `seq`, never by timestamp. Retries are idempotent on `(sender_id, client_msg_id)`.
- **One direct chat per pair** is enforced by the database (`conversations.direct_key`), not only by code.
- **Observability.** JSON logs with a request ID on every line (`X-Request-Id` is accepted and echoed back). `GET /health` reports dependencies, `GET /ready` returns 503 when one is down, and `GET /metrics` serves Prometheus metrics. There's a Grafana dashboard in `infra/grafana/`. Sentry (`SENTRY_DSN`, `VITE_SENTRY_DSN`) and OpenTelemetry tracing (`OTEL_EXPORTER_OTLP_ENDPOINT`) are opt-in through env vars.
- **Design system.** Tokens live in `apps/web/src/styles/tokens.css` (light and dark themes). Base components are in `apps/web/src/components/ui`. The living UI kit is at http://localhost:5173/ui.

The web app currently shows **sample conversations** (`apps/web/src/features/conversations/sampleData.ts`) so the layout can be reviewed. They are replaced by real data in M1 (CHAT-015, CHAT-016).

## Deployment

CI runs on every pull request and push to `master`. Staging is on Render, and Render deploys `master` only after CI passes. Setup steps are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Backlog

M0 (Foundations) covers CHAT-001 to CHAT-006. The next milestone is M1: sign-up, realtime gateway and text chat.
