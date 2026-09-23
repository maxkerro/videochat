# Deployment (staging on Render)

## How it works

1. Every pull request and push to `master` runs the **CI** workflow (`.github/workflows/ci.yml`). It checks formatting, lint and types, runs the unit and integration tests against real Postgres and Redis, builds everything, applies the migrations to an empty database, audits production dependencies, and builds the API Docker image.
2. Render watches `master`. `render.yaml` sets `autoDeployTrigger: checksPass`, so Render deploys a commit **only after its GitHub checks pass**. A red CI means no deploy.
3. On start, the API container applies pending migrations (`docker-entrypoint.sh`) and then boots. Render routes traffic only after `/ready` returns 200.
4. The **Staging smoke test** job waits until `GET /health` on staging reports the new commit, then checks `/ready`. It links the staging URL on the GitHub `staging` environment and in the run summary.

## One-time setup

1. **Create the services.** In Render, go to **New → Blueprint**, select this repository, and apply `render.yaml`. This creates:
   - `videochat-api`: a Docker web service
   - `videochat-web`: a static site
   - `videochat-db`: Postgres 17
   - `videochat-redis`: Key Value (Redis-compatible)

   All of them run in Frankfurt.

2. **Fill the secret values** that the Blueprint asks for, once the first deploy has given each service its URL:
   - `videochat-api` → `CORS_ORIGINS` = the web URL, e.g. `https://videochat-web.onrender.com`
   - `videochat-web` → `VITE_API_URL` = the API URL, e.g. `https://videochat-api.onrender.com`
   - Optional: `SENTRY_DSN` (API) and `VITE_SENTRY_DSN` (web)

   Then redeploy the web service, because Vite bakes `VITE_*` values in at build time.

3. **Wire up GitHub.** Go to **Settings → Secrets and variables → Actions → Variables** and add `STAGING_API_URL` and `STAGING_WEB_URL`. Without them, the smoke-test job is skipped.
4. **Protect `master`.** Go to **Settings → Branches**, add a rule for `master`, and require the checks _Lint, typecheck, test, build_ and _API Docker image builds_ before merging.

## Things to know

- **Free plan limits.** Free web services sleep after about 15 minutes idle, so the first request takes around 30 s. Free Postgres databases expire after 30 days. Upgrade `videochat-db` (and ideally `videochat-api`) to a paid plan before anyone relies on staging.
- **Migrations** are forward-only (Drizzle). To change the schema, edit `apps/api/src/db/schema.ts`, run `pnpm db:generate`, review the SQL in `apps/api/drizzle/`, and commit it with the code that needs it. Write migrations so that the previous release still works against the new schema: add columns first, remove them in a later release.
- **Metrics.** `/metrics` is public in staging. Restrict it (for example with an auth token or a private network) before production. Import `infra/grafana/videochat-api.dashboard.json` into Grafana (for example Grafana Cloud) and point a Prometheus scrape job or Grafana Alloy at `/metrics`.
- **Tracing.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` on the API (for example a Grafana Cloud, Honeycomb or Jaeger OTLP endpoint) to send traces. Logs then include `trace_id`.
