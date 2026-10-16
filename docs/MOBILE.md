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
`POST /push/devices` (with the login's refresh token, so the device is bound to that session and removed when it ends), re-registers if the token rotates, and removes it on sign-out. A tap on a
notification opens `/c/<id>` (only a well-formed conversation id is accepted), including when the
tap launched the app. The icon badge shows the unread total (muted chats excluded; whether it shows
depends on the phone's launcher). Server setup is in `DEPLOYMENT.md`. Push needs `google-services.json`
in `apps/mobile/` listing the variant's package and a native build (version `0.4.0`); iOS needs an Apple developer account and is
not wired yet.

## Attachments and gestures (CHAT-056/057, report from CHAT-058)

**Sending photos and files.** The **+** button opens a sheet: take a photo, choose a photo, choose a
file. The camera permission is asked the first time the camera is used (if it was refused for good,
the app offers to open Settings); the photo library uses the system picker and needs none. Photos
are shrunk to at most 2048 px on the long side and re-encoded as JPEG at quality 0.8 before upload
(`src/chat/prepareFile.ts`; GIFs and other files go up untouched), so a 12 MP photo is well under
1 MB and an iPhone's HEIC arrives as a JPEG everyone can show.

**Uploads outlive the screen.** A picked file is handed to an app-wide manager (`src/uploads/`), not
to the chat screen: leaving the chat does not stop it, and the file shows in the chat as a bubble
with its progress (preparing, uploading %, sending), with Cancel. A failed attempt (no connection,
expired link, storage or server error) is retried automatically twice, with a fresh upload link
each time; after that the bubble says why and offers Retry/Delete. A retry resumes where it
stopped (a file that is already uploaded is not uploaded again) and reuses the message's
`clientMsgId`, so the server never delivers it twice. Signing out cancels all uploads. They do not
survive the app being killed (there is no on-disk queue for files), and they do not run while the
app is in the background for long.

**Gestures.** Swipe a message to the right to reply (the bubble follows the finger, a haptic tick
marks the point where letting go counts; with "reduce motion" on the bubble stays still). Long-press
for the menu: quick reactions, Reply, Copy text, Edit, Delete, and Report on other people's
messages. Everything in the menu is also reachable with a screen reader: the bubble offers the
actions Reply, Copy text and "More" (the full menu).

**Report.** Report asks for a reason (spam, harassment, inappropriate, other) and calls
`POST /conversations/:id/messages/:messageId/report`. The server stores the report with a copy of
the text (migration `0012`) and logs it as `message.reported`; there is no moderation screen yet,
so check the logs or the `message_reports` table.

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

## Calls (CHAT-060)

Calls use the same signalling as the web app (`call.*` events over the one realtime socket, ICE
servers from `GET /calls/ice-servers`), so a phone and a browser call each other in both
directions.

- **Engine** (`src/calls/CallEngine.ts`): a port of the web `CallEngine` -- the state machine,
  perfect negotiation, ICE restart, quality stats, end-of-call summary. It talks to WebRTC through
  the small interfaces in `rtc.ts`, so it runs (and is tested) under plain Node. Keep the two
  engines in step until they move into `packages/shared`.
- **Native side** (`nativeDeps.ts`, the only file that imports `react-native-webrtc`): media,
  peer connections, ICE servers and stats wired to the app's socket and API.
- **Provider and screen** (`CallProvider.tsx`, `CallOverlay.tsx`): mounted inside `(app)/_layout`.
  The call screen is drawn over the whole app (ringing, calling, live call, "Call ended"), with
  mute, camera on/off, front/back camera and hang up. Android's back button is ignored while a call
  is on screen. The audio/video buttons are in the header of a direct chat.
- **Permissions** (`media.ts`): react-native-webrtc shows the system prompts and leaves out a track
  whose permission was refused, so `acquireMedia` checks what came back. No microphone: the call
  cannot start, with a button to the phone's settings. No camera on a video call: the call goes
  ahead with sound only and explains how to turn the camera on.
- **Socket in the background:** while a call lasts, the realtime socket stays open however long the
  app is in the background (`controller.setInCall`).
- **Config:** the `@config-plugins/react-native-webrtc` plugin adds the camera/microphone texts and
  Android permissions; `SYSTEM_ALERT_WINDOW` (which the plugin adds) is blocked. The image picker's
  `microphonePermission` must not be `false` -- that removes `RECORD_AUDIO` from the Android
  manifest (guarded by `src/appConfig.test.ts`).
- **Native modules:** the WebRTC module (now `@livekit/react-native-webrtc`, see CHAT-061) and `expo-keep-awake` are native, so this is version
  `0.5.0` and needs a new APK.
- **Ringing with the app closed or the phone locked:** see CHAT-061 below.

## Audio routing and picture-in-picture (CHAT-062)

- **Routing** (`audioRoute.ts`, `nativeAudio.ts`): the native call library (CHAT-061) owns the
  call audio; the app applies the loudspeaker switch and reads the route in use. Defaults: speaker for
  video, earpiece for audio, and a connected Bluetooth or wired headset beats both. A headset that
  connects mid-call takes over at once (no pick needed); when it goes away the sound returns to
  the phone. The route button in the call controls swaps speaker and phone with one tap, and opens
  a row of choices when Bluetooth or a headset is also available. The system call library can only force the speaker; picking the phone while a headset is connected may not move the sound, so the app reads the real route back shortly after a pick. An explicit pick is kept until it
  becomes impossible. Android 12+ needs `BLUETOOTH_CONNECT` to see a paired headset; the app asks
  when a call is set up and works without it. On iOS the system routes to headsets itself, so only
  speaker vs. phone is offered.
- **Picture-in-picture:** on Android (`expo-pip`) a connected video call shrinks into a small
  window when the app is left (Home, recents, back); the Minimise button does the same on demand.
  On iOS the other person's video view (`RTCPIPView`) becomes the PiP window (iOS 15+; the app
  declares the `audio` background mode). In the small window only the other person (or their photo)
  is shown.
- **Camera in the background:** when the app is out of sight and not in the small window, the
  camera is switched off (`CallEngine.setVideoPaused`) and the other side sees "camera off"; it
  returns with the app. What the person chose (`videoEnabled`) is not changed by this.
- **Native modules:** `expo-pip` is native (still version `0.5.0` -- 0.5.0 has not been
  released yet).
- **Android audio in the background:** since Android 11 the microphone is silenced for an app that
  is in the background unless it runs a foreground service. A video call is fine (the small window
  keeps the app visible); an _audio-only_ call that is left for another app relies on the
  foreground service the native call library runs for every call (CHAT-061).

## Calls on the lock screen (CHAT-061)

Incoming and outgoing calls are registered with the phone's own call system through
`expo-callkit-telecom` (CallKit on iOS, Core-Telecom on Android), via `callBridge.ts` (the
logic, tested with a fake) and `nativeCallUi.ts` (the library).

- **Android, app closed or locked:** when a call is placed, the API sends the callee's Android
  phones a high-priority, data-only FCM message (`messageType: incomingCall`, built in
  `fcm-push.channel.ts`, sent by `CallPushService` -> `NotificationsService.notifyIncomingCall`). The
  library's FCM service in the app turns it into the system call screen even with the app killed,
  with a 30 s TTL (the server's ring timeout). The payload's `metadata.conversationId` is what lets
  the app open the right conversation.
- **Answering:** the answer on the system screen starts the app, which shows the call
  (`CallEngine.presentIncoming`), gets the microphone, waits for the realtime socket to open (up to
  20 s), then sends `call.accept` and negotiates as usual. Declining from the system screen sends
  `call.decline`; a ring that ran out (system screen ended near 30 s) is left to the server as
  _missed_, not turned into _declined_.
- **App open:** `call.incoming` over the socket reports the call to the same system screen. If the
  push already did, the existing system call is adopted (one id: the call id). The in-app screen is
  a fallback; its Answer button goes through the system so both stay in step.
- **Outgoing calls** are registered too, which gives Android the foreground service that keeps the
  microphone alive in the background (audio-only calls).
- **Stale answers:** if the caller gave up before a cold-started phone's socket came up, the late
  `call.accept` is answered by the server with `call.ended` (it replies to the losing device), so the
  call screen closes. Hanging up while still waiting for the socket declines the call. Any decline (lock screen, in-app, or a failed answer) made before the socket is registered is sent as soon as it is (`realtime.ready`); before that the server ignores events, so the app does not count them as sent. An accept or a decline is tried up to three times as the socket comes and goes (an accept that never gets out fails the call instead of leaving it on "connecting"); after that the server's 30 s ring timeout ends the call. Only the callee can accept, decline or ring a call (server-side, tested).
- **Answer failures:** if the microphone cannot be opened for a call answered through the system
  (lock screen, or the in-app Answer button, which goes through the system), the call is declined.
- **Push content:** the push carries the caller's name (not the photo: that is a signed storage URL, kept out of the push service; the system screen shows initials) and the conversation id
  (`metadata.conversationId`, which the app needs to start from the push alone); "previews off"
  does not apply to a call screen.
- **Missed calls:** unchanged -- the server posts the "Missed call" chat message and notification
  (CHAT-044/055).
- **Native modules:** WebRTC is now `@livekit/react-native-webrtc` (same API as `react-native-webrtc`;
  the iOS call audio needs this build), plus `expo-callkit-telecom`, and `expo-build-properties`
  (Android `minSdkVersion` 26). Still version `0.5.0` (unreleased).
- **Known limits:** (0) **No proximity sensor:** the previous audio manager turned the screen off
  against the ear on the earpiece; the native call library does not, so on an audio call a cheek can
  press the screen (mute / hang up). Tracked as CHAT-083 (a proximity wake lock while the route is the earpiece).
  (1) Declining from the lock screen while the app is _killed_ only reaches the
  server once the app is running; otherwise the caller keeps ringing until the 30 s timeout. (2) A
  caller cancelling while the phone is ringing with the app killed does not dismiss the system
  call screen until its own 30 s timeout (the app is not running to hear `call.ended`). (3) **iOS
  is not built or tested**: ringing with the app killed needs a PushKit VoIP push, which needs an
  Apple developer account and APNs credentials; the server has no APNs channel yet. Apple requires
  every VoIP push to show a call, so VoIP pushes must never be used for ordinary messages. On iOS
  only the foreground path (app open) is in place.

## Group calls (CHAT-070)

In a group chat, the header's 📹 starts a group call (LiveKit, see docs/DEPLOYMENT.md); while one
runs, a banner under the header shows how many are in it and lets anyone join. The call screen
(`src/groupCalls/GroupCallScreen.tsx`) shows one tile per person (one fills the screen, two stack, then
two columns, scrolling past 8), outlines whoever is speaking, and has mute, camera, switch camera and
leave. It joins with the microphone on and the camera off. Minimise keeps the call and shows a bar
over the app. Sound goes to a headset or Bluetooth device when one is connected, else the loudspeaker.

- **Setup:** `registerGlobals({ autoConfigureAudioSession: false })` runs first thing
  (`src/groupCalls/setup.ts`, imported by `app/_layout.tsx`); the LiveKit Expo plugin sets up the
  native side. `@livekit/react-native` is native, so this is still the unreleased `0.5.0`.
- **One call at a time:** no group call during a 1:1 call and no 1:1 call during a group call.
  A 1:1 call that comes in during a group call still rings (the system call screen); answering it
  leaves the group call.
- **Known limit:** the group call keeps going while the app is open (also minimised). Android silences
  the microphone of an app in the background unless it runs a foreground service, which group calls
  don't register yet; leaving the app mutes you to the others until you come back.
- **iOS** is not built or tested (no Apple account). Its audio session for group calls is set up with
  `setupIOSAudioManagement` while the call runs.

## Screen sharing (CHAT-071)

Sharing a screen is a desktop-browser feature (web): in a 1:1 call the shared screen replaces the
camera on the same video track (a call without a camera adds one, one renegotiation), and
`call.media` carries `screen: true` so the other side shows it whole rather than cropped. In group
calls it is LiveKit's screen-share track, and a shared screen takes the main stage. The phone app
only _views_ shared screens: full-size and letterboxed in a 1:1 call, above the tiles in a group
call. Sharing from the phone is later.

## Message search (CHAT-072)

"Search" on the Chats screen searches the text and file names of every chat you're in; "Search in
this chat" on a chat's info screen limits it to that chat. Filter chips narrow to files or photos
and to the past week, month or year. Tapping a result opens the chat, loads history back to that
message (200 at a time) and outlines it for a moment. Needs no native changes.

## @mentions (CHAT-073)

In a group, typing "@" in the composer lists matching members (by username or name); tap one to
insert `@username`. Messages that mention you are marked with an accent edge and your name is
highlighted. Chats with unread mentions show an "@" badge, and a "Mentions" filter appears on the
Chats screen while there are any. Being mentioned notifies you even in a muted group; Settings →
"Mentions in muted chats" turns that off. Needs no native changes.

## Voice messages (CHAT-074)

With the message box empty the Send button becomes a microphone: hold it to record, let go to
send, slide left to cancel ("Release to cancel" shows when you've slid far enough). Recording stops
and sends by itself at 5 minutes; a tap shorter than 0.7 s sends nothing. With TalkBack/VoiceOver,
double-tap starts recording and a second double-tap sends. Recording is off during a call.

- Recorded as AAC in MP4 (`.m4a`, mono, 64 kbps), which every phone and browser plays.
- Playback: play/pause, tap the waveform to jump, 1x / 1.5x / 2x (the speed is remembered). One
  message plays at a time, through one app-wide player, so it keeps playing while you scroll,
  leave the chat or lock the phone; Android shows media controls in the notification shade while
  it plays. A call stops it.
- **Native change:** adds `expo-audio` with background playback (iOS `UIBackgroundModes: audio`;
  Android `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and its media service). Needs a new APK.
- Known limit: voice messages recorded in a browser other than Safari are Opus in WebM, which the
  native iOS player can't play (Android and all browsers can). Only matters once there is an iOS
  build; the fix would be transcoding to AAC on the server.
