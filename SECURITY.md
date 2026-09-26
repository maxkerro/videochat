# Security review (CHAT-022)

This is the OWASP ASVS (Application Security Verification Standard) **Level 1** checklist for
this app's MVP, written as CHAT-022's "review-gate" AC ("checklist completed and stored in the
repo"). Each item names the actual mechanism and file in _this_ codebase, not generic advice --
where something is deferred or only partially satisfied, that's called out explicitly rather than
marked done.

Scope: `apps/api` (the NestJS API) and, where noted, `apps/web` (the Vite SPA) and the deployment
config (`render.yaml`, `.github/workflows/ci.yml`). Level 1 is "every application should achieve
this" -- it's what this MVP is being held to before first release; Level 2/3 controls (e.g.
hardware-backed key storage, formal threat modelling) are out of scope for M1.

## V2 -- Authentication

| #   | Requirement                                                                                        | Status | Where                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1 | Passwords hashed with a memory-hard algorithm (Argon2id/bcrypt/scrypt), never plaintext/reversible | Done   | `apps/api/src/auth/password.ts` -- Argon2id, OWASP-recommended params (m=19 MiB, t=2, p=1)                                                                                                                                                       |
| 2.2 | Account lockout / rate limiting after repeated failed logins                                       | Done   | Per-account lockout: `apps/api/src/db/users.ts` (`recordFailedLogin`/`lockedUntil`), checked in `AuthService.login`. Per-IP rate limit on the endpoint itself (CHAT-021): `apps/api/src/rate-limit/rate-limit.guards.ts` (`LoginThrottlerGuard`) |
| 2.3 | Generic error on failed login (doesn't reveal whether the email exists)                            | Done   | `AuthService.login`'s `invalid()` -- same message for "no such user" and "wrong password"                                                                                                                                                        |
| 2.4 | Email verification before an account can do anything meaningful                                    | Done   | `AuthService.login` rejects with 403 if `emailVerifiedAt` is unset; token-based verification in `verifyEmail`                                                                                                                                    |
| 2.5 | Password reset tokens are single-use, short-lived, and delivered out-of-band                       | Done   | `apps/api/src/db/auth-tokens.ts` (`consumeAuthToken` deletes on use), 30-minute TTL in `AuthService`, emailed via `MailService`                                                                                                                  |
| 2.6 | No secrets/credentials in source control                                                           | Done   | `.env` is gitignored; `.env.example` holds placeholders only; `JWT_SECRET`/DB/SMTP/S3 credentials are Render env vars (`render.yaml`, `sync: false` or `generateValue: true`)                                                                    |

## V3 -- Session management

| #   | Requirement                                                                                                 | Status                          | Where                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1 | Session tokens are unpredictable and generated with a CSPRNG                                                | Done                            | `apps/api/src/auth/tokens.ts` (`generateOpaqueToken`, `node:crypto`); JWT access tokens are HMAC-signed (`@nestjs/jwt`)                                                                                                  |
| 3.2 | Sessions expire; there's a way to invalidate one server-side                                                | Done                            | Access tokens: 15 min (`JWT_ACCESS_TTL_MIN`). Refresh tokens: 30 days (`JWT_REFRESH_TTL_DAYS`), revocable via `revokeFamily`/`revokeAllForUser` (`apps/api/src/db/refresh-tokens.ts`), used on logout and password reset |
| 3.3 | Refresh token reuse (replay of an already-rotated token) is detected and the whole session family is killed | Done                            | `AuthService.refresh` -- see its own comment: the revoke-as-gate design; a second presentation of a dead token calls `revokeFamily`                                                                                      |
| 3.4 | Session cookie flags: `HttpOnly`, `Secure` (in production), scoped `Path`                                   | Done                            | `apps/api/src/auth/refresh-cookie.ts` -- `httpOnly: true`, `secure: NODE_ENV === 'production'`, `path: '/auth'`                                                                                                          |
| 3.5 | CSRF protection for cookie-authenticated state-changing requests                                            | Done -- see full write-up below | `apps/api/src/auth/refresh-cookie.ts` (`sameSite: 'strict'`) + strict `CORS_ORIGINS` allow-list                                                                                                                          |

### CSRF risk assessment (CHAT-022, the detailed version)

This app's authentication is **not** the traditional "ambient cookie session" shape that classic
CSRF targets. Every endpoint that changes state on a user's behalf -- every conversation and
message route, group admin actions, blocking, profile edits, avatar upload -- requires a Bearer
access token in the `Authorization` header (`AccessTokenGuard`). A browser never attaches that
header on its own; a cross-site `<form>` POST, an `<img>`, or a `fetch(..., {mode:'no-cors'})` from
an attacker's page cannot forge it. So the entire application surface that CSRF classically
targets was **already not exposed**, before this story, simply as a consequence of the auth
scheme CHAT-010 chose.

The one cookie in the system is the httpOnly refresh token, sent automatically to `/auth/refresh`
and `/auth/logout`. That's the actual CSRF-relevant surface, and it now has two independent
mitigations:

1. **`SameSite=Strict`** (tightened from `Lax` as part of this story). The browser will not attach
   this cookie to any cross-site request at all. `Lax` would already have blocked a forged request
   here too, since both endpoints are POST-only and `Lax` only allows a cookie through on a
   top-level cross-site _GET_ navigation -- but `Strict` costs nothing (nothing in this app relies
   on the refresh cookie surviving a cross-site top-level navigation, e.g. clicking an email link)
   and removes that distinction as something to reason about at all.
2. **Strict CORS** (`app.enableCors({ origin: env.CORS_ORIGINS, credentials: true })` in
   `app.factory.ts`, `CORS_ORIGINS` env-driven per `config/env.ts`). A cross-origin
   `fetch('/auth/refresh', { credentials: 'include' })` from any origin not on that list fails the
   browser's CORS check, and `Access-Control-Allow-Credentials` is never sent alongside a wildcard
   origin. In production, `render.yaml` additionally proxies the SPA and API through the same
   origin, so the cookie is same-site in the deployed topology as well, not just same-site by cookie
   attribute.

**Conclusion: no separate CSRF token (double-submit cookie or synchronizer token) was added.** It
would defend against the same "browser attaches the refresh cookie to a request the user didn't
intend" scenario that `SameSite=Strict` and strict CORS already close, at the cost of the SPA
having to mint, store and thread a token through the one cookie-only flow. If this app ever adds a
traditional cookie-authenticated session for a use case where `Authorization` headers don't fit
(e.g. a plain `<form>` submission, a webhook-style callback endpoint), that new endpoint would need
its own explicit look at this, since the reasoning above is specific to "every stateful endpoint
requires a bearer token except this one narrow refresh flow" -- it is not a blanket "this app is
immune to CSRF" claim.

Automated coverage: `apps/api/test/app.e2e.spec.ts` asserts the CORS allow-list actually rejects an
unlisted `Origin`. There's no browser-level automated test of `SameSite` itself (it's a client-
enforced attribute vitest/supertest can't simulate realistically), so this is verified by reading
the cookie flags off the `Set-Cookie` header in the auth e2e/int suites and by this write-up rather
than a dedicated integration test.

## V4 -- Access control

| #   | Requirement                                                                                                                       | Status                                              | Where                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Every state-changing/data-reading endpoint enforces authentication                                                                | Done                                                | `AccessTokenGuard` applied at the controller class level on `ConversationsController`, `MessagesController`, and per-route on `UsersController`; verified for every route by `apps/api/test/authorization.e2e.spec.ts`'s "unauthenticated" sweep (401 on every one) |
| 4.2 | Object-level authorization: a user can only act on resources they have a real relationship to (not just "any authenticated user") | Done                                                | Conversation/message routes check membership per-request (`findConversationForUser`/`getMembership`/`isConversationMember`), not just a valid token -- see the dedicated sweep below                                                                                |
| 4.3 | Privilege distinction within a resource (e.g. group admin vs. plain member) is enforced server-side, not just hidden in the UI    | Done                                                | `ConversationsService.requireGroupAdmin` -- rename, add-members, remove-member all require `role === 'admin'`; `apps/api/test/authorization.e2e.spec.ts` asserts a plain member gets 403 on these, distinct from a non-member's 404                                 |
| 4.4 | A non-member cannot distinguish "this conversation doesn't exist" from "this conversation exists but you're not in it"            | Done (a deliberate 404, not a 403, for non-members) | See `ConversationsService.requireGroup`'s and `MessagesService.requireMember`'s own comments                                                                                                                                                                        |

### "Member-only access" AC -- verification

**Before this story, individual endpoint test files already asserted member-only access for the
one endpoint each was otherwise testing** (`conversations.e2e.spec.ts`, `messages.e2e.spec.ts`).
As part of this story:

- Every controller method touching a `:conversationId`-shaped route was read (both
  `ConversationsController` and `MessagesController`, in full) and traced to the service-layer
  membership check it relies on. All of them do check membership -- `getById`, `listMembers`,
  `rename`/`addMembers`/`removeMember` (via `requireGroupAdmin`), `leave`, `markRead`,
  `markUnread`, and both message routes (`send`, `listPage`/`listAfter`) -- **no gap was found**;
  every one already 404s a non-member. `startDirect` and `createGroup` have no prior conversation
  to be a non-member _of_ (they create one), so they're out of scope for this check, and were
  read to confirm that.
- A new dedicated file, `apps/api/test/authorization.e2e.spec.ts`, was added specifically so this
  is one comprehensive assertion about the whole surface rather than something only true by every
  other test file coincidentally remembering to check it. It exercises every one of the routes
  above, for both a direct and a group conversation, as a genuine outsider, and asserts a uniform
  404; separately asserts that a real member without admin rights gets 403 (not 404) on the
  admin-only actions; and separately asserts every route 401s with no access token at all, before
  membership is even considered.

## V5 -- Input validation and encoding

| #   | Requirement                                                                                | Status             | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | All input is validated against a schema, not just type-coerced                             | Done               | Every controller body/query goes through `ZodValidationPipe` with a shared Zod schema from `@videochat/shared` (`packages/shared/src/schemas.ts`)                                                                                                                                                                                                                                                                                                                                                    |
| 5.2 | Path parameters that should be UUIDs are validated as such (not passed straight to the DB) | Done               | `apps/api/src/common/uuid-param.pipe.ts` (`UuidParamPipe`) -- non-UUID ids 404 rather than reaching a query                                                                                                                                                                                                                                                                                                                                                                                          |
| 5.3 | Output encoding / no unsanitized HTML rendering of user content                            | Partially deferred | The API returns JSON only (no server-rendered HTML, so no server-side XSS surface). The SPA renders message bodies as React text content (never `dangerouslySetInnerHTML`), which is XSS-safe by default -- confirmed by reading `apps/web/src/features/chat/linkify.tsx`. A dedicated review of every place user content is rendered client-side wasn't re-run as part of _this_ story (out of scope: this story's stated scope is the API's own hardening, not a full SPA content-rendering audit) |

## V7 -- Error handling and logging

| #   | Requirement                                               | Status      | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | Errors don't leak stack traces or internals to the client | Done        | Nest's default exception filter returns `{statusCode, message, error}` only; unhandled errors become a generic 500 (verified implicitly by every e2e spec asserting specific 4xx bodies rather than 500s)                                                                                                                                                                                                                                                                                 |
| 7.2 | Sensitive values are not written to logs                  | Mostly done | `apps/api/src/logging/logging.module.ts` redacts the realtime `?token=` query param from request logs; request/response bodies aren't logged at all by the pino-http config (only method/URL/status/timing), so passwords and tokens in POST bodies never reach a log line by construction. The module's own comment calls out one known gap: the WS upgrade request itself bypasses this app's logging pipeline entirely (a `ws`-adapter limitation, tracked separately, not fixed here) |
| 7.3 | Centralized error/exception tracking                      | Done        | Sentry (`@sentry/nestjs`, `apps/api/src/instrument.ts`), optional via `SENTRY_DSN`                                                                                                                                                                                                                                                                                                                                                                                                        |

## V9 -- Communications security

| #   | Requirement                                                         | Status                 | Where                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9.1 | TLS in transit in production                                        | Done (at the platform) | Render terminates TLS for both `videochat-api` and `videochat-web`; `secure: true` on the refresh cookie in production means it's never sent over plain HTTP                                                             |
| 9.2 | No mixed content / hardcoded `http://` origins in production config | Done                   | `PUBLIC_WEB_URL`/`CORS_ORIGINS` are required to be set explicitly (not left at their `localhost` defaults) in production -- enforced by `config/env.ts`'s `envSchemaWithProductionChecks`, which fails startup otherwise |

## V11/V14 -- HTTP security configuration

| #    | Requirement                                                                       | Status                                      | Where                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.1 | Security headers set on every response (`X-Content-Type-Options`, CSP, etc.)      | Done                                        | `helmet()` (explicitly configured, not left at defaults) in `apps/api/src/app.factory.ts`; asserted in `apps/api/test/app.e2e.spec.ts`                                                                                                                           |
| 11.2 | CSP blocks inline script execution                                                | Done                                        | `script-src 'self'` only (no `'unsafe-inline'`/`'unsafe-eval'`), `script-src-attr 'none'` (blocks inline event-handler attributes too); test: `apps/api/test/app.e2e.spec.ts` ("sends a Content-Security-Policy header whose script-src excludes unsafe-inline") |
| 11.3 | CORS is an explicit allow-list, not a wildcard                                    | Done                                        | `CORS_ORIGINS` env var (comma-separated), `config/env.ts`; defaults to the local dev origin only, must be set explicitly in production                                                                                                                           |
| 11.4 | Dependency vulnerability scanning runs in CI and fails the build on critical CVEs | Done (pre-existing, verified still passing) | `.github/workflows/ci.yml`'s "Dependency audit (fail on critical)" step -- `pnpm audit --prod --audit-level critical`. Confirmed clean (`No known vulnerabilities found`) as of this review                                                                      |
| 11.5 | HSTS in production                                                                | Done                                        | Included in helmet's defaults (not disabled); Render terminates TLS in front of it                                                                                                                                                                               |

### Known gap called out, not fixed in this story

The SPA's `index.html` (`apps/web/index.html`) has one inline `<script>` (applies the saved
light/dark theme before first paint, to avoid a flash). The CSP hardened in this story is served
by the **API**, on the API's own responses -- it says nothing about what headers the **static
site** (`videochat-web`, a Render static service serving pre-built HTML/JS) sends, and Render's
static-site config in this repo doesn't currently set any custom response headers at all. If a CSP
were added to the static site's responses with the same `script-src 'self'` policy, that inline
script would need a nonce or hash, or to move to an external file, to keep working. This is
deferred rather than fixed here because it requires either wiring nonces through the static build
(Vite doesn't do this out of the box) or a small refactor of that one script, and this story's
stated scope is the API's own headers/CORS/CSRF/authorization hardening, not the static site's
build pipeline -- flagging it here so it's a tracked decision, not a silent gap.

## V1 -- Architecture (this checklist itself)

Stored in the repo at `SECURITY.md` (this file), satisfying the AC directly.

---

_Last reviewed: CHAT-022, 2026-09-26. Re-review whenever a new conversation/message endpoint, a
new cookie, or a new client origin is added -- none of the above is a one-time check._
