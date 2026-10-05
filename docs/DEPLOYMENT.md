# Deployment (staging on Render)

## How it works

1. Every pull request and push to `master` runs the **CI** workflow (`.github/workflows/ci.yml`). It checks formatting, lint and types, runs the unit and integration tests against real Postgres and Redis, builds everything, applies the migrations to an empty database, audits production dependencies, and builds the API Docker image.
2. Render watches `master`. `render.yaml` sets `autoDeployTrigger: checksPass`, so Render deploys a commit **only after its GitHub checks pass**. A red CI means no deploy.
3. On start, the API container applies pending migrations (`docker-entrypoint.sh`) and then boots. Render routes traffic only after `/ready` returns 200.
4. The **Staging smoke test** job waits until `GET /health` on staging reports the new commit, then checks `/ready`. It links the staging URL on the GitHub `staging` environment and in the run summary.

## One-time setup

1. **Create a Neon Postgres project.** Render's free Postgres expires 30 days after creation, so the database lives on [Neon](https://neon.com) instead, which has no expiration on its free tier:
   - Sign up at neon.com, create a project (pick the region closest to Frankfurt, e.g. `eu-central-1`), database name `videochat`.
   - Copy the pooled connection string from the Neon dashboard (**Connect** → looks like `postgresql://user:pass@ep-xxx-pooler.eu-central-1.aws.neon.tech/videochat?sslmode=require`). Keep it handy for step 3.

2. **Create the Render services.** In Render, go to **New → Blueprint**, select this repository, and apply `render.yaml`. This creates:
   - `videochat-api`: a Docker web service
   - `videochat-web`: a static site
   - `videochat-redis`: Key Value (Redis-compatible)

   All of them run in Frankfurt. (Postgres is intentionally not in the Blueprint — see step 1.)

3. **Fill the secret values** that the Blueprint asks for:
   - `videochat-api` → `DATABASE_URL` = the Neon connection string from step 1
   - `videochat-api` → `JWT_SECRET` = a random 32+ char string, e.g. `openssl rand -hex 32` (also required so the API can issue tokens)
   - `videochat-api` → `CORS_ORIGINS` = the web URL, once the first deploy has given it one, e.g. `https://videochat-web.onrender.com`
   - `videochat-api` → `PUBLIC_WEB_URL` = the web URL, same as above (used to build verification/reset links -- must not be left at its localhost default in production)
   - `videochat-api` → `SMTP_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` = real values; these default to localhost/dev placeholders that silently fail in production (mail never sends, avatar uploads never persist). Working values for this project's providers (Resend for mail, Backblaze B2 for storage):
     - `SMTP_URL=smtps://resend:<RESEND_API_KEY>@smtp.resend.com:2465` -- **must be port `2465`, not the standard `465`**: Render blocks outbound `465`/`587` (a common anti-spam policy on PaaS platforms), so a plain `465` URL just hangs until nodemailer's connection times out. Resend publishes `2465`/`2587` specifically for hosts that do this. Keep the `smtps://` scheme (implicit TLS) to match `2465` -- `smtp://` on that port gets a connection but no SMTP greeting, since the server expects TLS immediately.
     - `MAIL_FROM=Videochat <onboarding@resend.dev>` -- **no surrounding quotes** in the Render dashboard value (it isn't a shell, so literal `"` characters become part of the address and Resend rejects it with `501 Bad sender address syntax`). `onboarding@resend.dev` is Resend's sandbox sender; without a verified domain, that's the only address Resend will send as.
     - `S3_ENDPOINT=https://s3.<region>.backblazeb2.com` (must include the `https://` scheme, e.g. `https://s3.eu-central-003.backblazeb2.com`), `S3_REGION=<region>` (e.g. `eu-central-003`, matching your bucket's actual region from the B2 dashboard), `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` = a B2 application key's keyID/applicationKey.
   - Optional: `SENTRY_DSN` (API) and `VITE_SENTRY_DSN` (web)

   `videochat-web` does **not** need `VITE_API_URL` set -- it proxies API paths through its own origin (see `render.yaml`'s `routes`), which is also what keeps the refresh-token cookie same-site instead of cross-site between the two `*.onrender.com` hosts.

   `VITE_REALTIME_URL` (CHAT-013) is the one exception: it **is** set in `render.yaml`, pointing straight at `wss://<api hostname>/realtime`. The realtime socket authenticates with the access token as a query parameter rather than the refresh-token cookie, so there's no same-site requirement, and going straight to the API avoids relying on the static-site rewrite proxy for a WebSocket upgrade. Update it alongside the API hostname in the `routes` section if the API service is ever recreated under a new name.

4. **Wire up GitHub.** Go to **Settings → Secrets and variables → Actions → Variables** and add `STAGING_API_URL` and `STAGING_WEB_URL`. Without them, the smoke-test job is skipped.
5. **Protect `master`.** Go to **Settings → Branches**, add a rule for `master`, and require the checks _Lint, typecheck, test, build_ and _API Docker image builds_ before merging.

## Things to know

- **Free plan limits.** Free web services sleep after about 15 minutes idle, so the first request takes around 30 s. Neon's free tier (0.5 GB storage, 100 compute-hours/month) does **not** expire, but its compute auto-suspends after 5 minutes idle, adding to that same cold-start delay. Render's free Redis (Key Value) is in-memory only — data is lost on restart; fine for cache/pub-sub, not for anything that must survive a restart (swap to Upstash's free tier if that changes). Upgrade to paid plans before anyone relies on staging being always-on or Redis being durable.
- **Migrations** are forward-only (Drizzle). To change the schema, edit `apps/api/src/db/schema.ts`, run `pnpm db:generate`, review the SQL in `apps/api/drizzle/`, and commit it with the code that needs it. Write migrations so that the previous release still works against the new schema: add columns first, remove them in a later release.
- **Metrics.** `/metrics` is public in staging. Restrict it (for example with an auth token or a private network) before production. Import `infra/grafana/videochat-api.dashboard.json` into Grafana (for example Grafana Cloud) and point a Prometheus scrape job or Grafana Alloy at `/metrics`.
- **Tracing.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` on the API (for example a Grafana Cloud, Honeycomb or Jaeger OTLP endpoint) to send traces. Logs then include `trace_id`.

## Calls: STUN/TURN (CHAT-040)

Calls are peer-to-peer WebRTC. Most connect directly using STUN; the rest (roughly 10-20%:
symmetric NATs, corporate firewalls that block UDP) need a TURN relay. The API hands each
signed-in caller a fresh server list from `GET /calls/ice-servers`, and any TURN credential in it
expires after `TURN_TTL_SEC` (1 h by default), so a leaked one can't be reused.

Render can't run coturn (it needs UDP ports), so staging uses a managed relay:

| `TURN_PROVIDER`  | What it does                                                                                                                                                                                                                                    | Needs                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `none` (default) | Public STUN only. Calls connect on most home networks.                                                                                                                                                                                          | nothing                                                                  |
| `cloudflare`     | Cloudflare Realtime TURN. Free tier is generous (about 1,000 GB/month relayed at the time of writing). Credentials are minted per call via Cloudflare's API; if that API is down, the API falls back to STUN only rather than failing the call. | `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`                    |
| `hmac`           | coturn's `use-auth-secret` scheme. Use with self-hosted coturn (or any TURN service that supports the "TURN REST API" shared-secret scheme). Credentials are derived locally, no network call.                                                  | `TURN_URLS`, `TURN_SECRET` (same value as coturn's `static-auth-secret`) |

**Switching staging to Cloudflare:** Cloudflare dashboard -> Realtime -> TURN -> create a TURN
key. Then on the `videochat-api` service set `TURN_PROVIDER=cloudflare` plus the key id and API
token. The API refuses to start if the provider is set without its credentials, so a typo shows
up as a failed deploy, not as calls that quietly can't relay.

**Self-hosted coturn (any VM with UDP):** run coturn with `use-auth-secret`,
`static-auth-secret=<TURN_SECRET>`, TLS on 443 (`turns:` URLs get through firewalls that block
UDP), and set `TURN_PROVIDER=hmac`, `TURN_URLS=turn:host:3478?transport=udp,turns:host:443?transport=tcp`.
`docker compose --profile turn up -d coturn` runs the same setup locally.

**Relay bandwidth monitoring:** relayed traffic is what TURN costs money for.

- Cloudflare: set a usage notification in the Cloudflare dashboard (Notifications -> Billing /
  usage) at, say, 80% of the free allowance.
- coturn: `--prometheus` exposes metrics on port 9641; alert on
  `rate(turn_traffic_sentb[1h])` crossing your monthly budget divided by 720 (hours in a month).

## Attachments: bucket CORS (CHAT-030)

Browsers upload attachments **straight to the bucket** with a signed `PUT` (the bytes never pass
through the API), and show images from signed `GET` URLs. The bucket therefore has to allow
cross-origin requests from the web app's origin, or every upload fails with a CORS error in the
browser console.

Backblaze B2 (this project's provider) -- with the [B2 CLI](https://www.backblaze.com/docs/cloud-storage-command-line-tools):

```sh
b2 bucket update --cors-rules '[
  {
    "corsRuleName": "videochat-web",
    "allowedOrigins": ["https://videochat-web-v219.onrender.com", "http://localhost:5173"],
    "allowedOperations": ["s3_put", "s3_get", "s3_head"],
    "allowedHeaders": ["content-type"],
    "exposeHeaders": ["etag"],
    "maxAgeSeconds": 3600
  }
]' <bucket-name>
```

(The B2 web UI's "CORS Rules" dialog only offers the B2-native API presets, which don't cover the
S3-compatible `PUT` used here -- use the CLI.) Local MinIO allows all origins by default.

Unsent uploads (a slot requested but no message sent) are removed with their objects after 24 h.
