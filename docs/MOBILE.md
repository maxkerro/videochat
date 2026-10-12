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

JavaScript-only fixes can ship without a new APK: `APP_VARIANT=staging npx eas-cli update --channel
staging --message "..."`. The app downloads the update on launch and applies it on the next
launch. Because `runtimeVersion` uses the `appVersion` policy, an update only reaches binaries with
the same `version` in `app.config.ts`: **bump `version` and make a new build whenever a native
dependency or native config changes.** Enabling EAS Update code signing is a sensible hardening
step before there are real users.

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
