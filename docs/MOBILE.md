# Mobile app (CHAT-050)

`apps/mobile` is a React Native app (Expo SDK 57, Expo Router, TypeScript) that lives in this
monorepo and reuses `@videochat/shared` -- the zod schemas, domain types and the typed API client
(`createApiClient`). The web app uses the same client, so a contract change breaks both at
typecheck time.

## Variants

One codebase, three installable apps that can sit side by side on a phone (`app.config.ts`,
selected by `APP_VARIANT`, which the EAS build profiles in `eas.json` set):

| Variant       | App name       | Bundle id / package          | Talks to               |
| ------------- | -------------- | ---------------------------- | ---------------------- |
| `development` | Chat (dev)     | `app.videochat.chat.dev`     | `EXPO_PUBLIC_API_URL`  |
| `staging`     | Chat (staging) | `app.videochat.chat.staging` | the Render staging API |
| `production`  | Chat           | `app.videochat.chat`         | the production API     |

Set `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_REALTIME_URL` to override the API for any variant. The
staging variant points at the Render API (`https://videochat-api-p6sw.onrender.com`); the
production host in `app.config.ts` is still a placeholder.

## Over-the-air updates

JavaScript-only fixes can ship without a new APK: from `apps/mobile` run `pnpm ota "message"`
(staging by default; `CHANNEL=production pnpm ota "..."` for production). It builds
`@videochat/shared`, then runs `eas update` for the channel. The app downloads the update on launch and applies it on the next
launch. Because `runtimeVersion` uses the `appVersion` policy, an update only reaches binaries with
the same `version` in `app.config.ts`: **bump `version` and make a new build whenever a native
dependency or native config changes.**

**Before the production channel has real users, turn on EAS Update code signing.** Without it,
anyone who controls the Expo account can push JavaScript that reads the refresh token from the
keystore. With it, the app only runs updates signed by a private key you keep off Expo (never
commit it; `apps/mobile/keys/` is git-ignored). Steps (check the current Expo docs for exact flags):
generate a key and certificate (`npx expo-updates codesigning:generate ...`), add
`codeSigningCertificate` and `codeSigningMetadata` to `updates` in `app.config.ts`, make a new
native build, and publish with `eas update --private-key-path <key>`.

## Screens, local database and outbox (CHAT-052/053)

Routes (expo-router): `(app)/index` inbox, `c/[id]` conversation, `c/[id]/info` chat info and group
management, `new` new chat or group, `profile`, `settings`.

- **Data:** TanStack Query over the authenticated API client (`src/data`). Until CHAT-054 lands the
  realtime socket, the open screens poll: the inbox every 15 s, an open conversation every 6 s, and
  only while the screen is showing and the app is in the foreground.
- **Local database** (`expo-sqlite`, `src/db`): conversations, the newest 500 messages per
  conversation, and the outbox. It is a cache: the server stays the source of truth. The inbox and
  a conversation render from it first, so chats open instantly and offline. It belongs to one
  account (`meta.owner`) and is wiped on sign-out and when a different account signs in.
- **Outbox** (`src/outbox`, `src/data/outboxRunner.ts`): every text message is written to the
  outbox _before_ the first send attempt and sent in typing order with its `clientMsgId`, so retries
  are idempotent. It flushes on start, on foreground, when the connection returns, and every 20 s
  while anything is waiting. A network problem stops the run (nothing overtakes); a 4xx answer marks
  that message failed ("Not sent", Retry or Delete) and the rest continue. Attachments need the
  network end to end (presigned upload), so they are not queued.
- **Native modules:** `expo-sqlite`, `expo-image-picker`, `expo-document-picker` and NetInfo are
  native, so this version (`0.2.0`) needs a new APK; an OTA update cannot reach the old binary.

## Realtime and push (CHAT-054/055)

**Socket.** While the person is signed in, online and in the app, one WebSocket (`/realtime`, the
same endpoint as the web) delivers new, edited and deleted messages, reactions, read receipts,
typing and presence straight into the caches the screens read (`src/realtime/events.ts`). It is
closed 30 s after the app goes to the background and reopened on return, and it follows the network:
airplane mode closes it, coming back reconnects it. "Open" means the server confirmed the
registration (`realtime.ready`); only then do screens drop to slow polling (60 s inbox, 30 s open
chat) as a safety net. On every reconnect and every return to the app the inbox, open chats and
presence are re-read, which fills any gap. An event that would leave a hole in the loaded messages
triggers a refetch instead of being shown. Events from an earlier session are dropped.

**Typing and "viewing".** The composer sends a typing signal at most every 3 s. The open chat tells
the server it is being viewed so no notification is sent for it.

**Push.** After sign-in the app asks for notification permission, registers its FCM token with
`POST /push/devices`, re-registers if the token rotates, and removes it on sign-out. A tap on a
notification opens `/c/<id>` (only a well-formed conversation id is accepted), including when the
tap launched the app. The icon badge shows the unread total (muted chats excluded; whether it shows
depends on the phone's launcher). Server setup is in `DEPLOYMENT.md`. Push needs `google-services.json`
in `apps/mobile/` and a native build (version `0.3.0`); iOS needs an Apple developer account and is
not wired yet.

## Running it

It uses a **development build**, not Expo Go: WebRTC and CallKit (M5) need native modules.

```sh
pnpm install
pnpm --filter @videochat/shared build     # the app imports the built package
pnpm --filter @videochat/mobile dev       # Metro, for an installed development build
```

### Simulators

```sh
pnpm --filter @videochat/mobile ios       # needs Xcode
pnpm --filter @videochat/mobile android   # needs Android Studio + an emulator
```

On a simulator or emulator, `localhost` is the host machine for iOS but `10.0.2.2` for Android:
set `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000` (and the realtime URL) when running the Android
emulator against the local API.

### A real Android phone (EAS APK, no store account needed)

1. Create a free account at expo.dev, then `npx eas-cli login` and, once, `npx eas-cli init`
   inside `apps/mobile`.
2. `npx eas-cli build --platform android --profile staging` (cloud build, free tier queues).
3. Open the build link on the phone and install the APK (allow "install unknown apps").

iOS device builds need a paid Apple Developer account; until then use the simulator
(`--profile development`, which builds a simulator app).

## CI

CI typechecks and lints the app, runs its unit tests, and bundles it with Metro for Android and
iOS (`expo export --no-bytecode`), which catches broken imports and shared-package resolution
problems. Native binaries are built by EAS, not CI.
