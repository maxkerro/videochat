# End-to-end encryption spike (CHAT-076)

The design, the protocol choice, the list of features that change, and the rollout plan are in the
shared design doc ("CHAT-076: End-to-end encryption — spike and plan"). This file covers the
prototype in the code.

## What the prototype does

- **Direct chats, text only, web.** With the flag on (see `DEPLOYMENT.md`), each browser that opts in
  gets its own MLS device identity (`userId:deviceId`, Ed25519 + X25519, cipher suite
  `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, library [ts-mls](https://github.com/LukaJCB/ts-mls)
  1.6.4).
- The first device to send in a DM claims one key package of every other registered device in the
  chat, creates the chat's MLS group, and leaves each device a Welcome. The others join from it the
  first time they need the group.
- Messages go to `POST /conversations/:id/messages` as `{ clientMsgId, e2ee: { v: 1, ciphertext } }`.
  The API stores `body = NULL` and the MLS ciphertext in `messages.meta.e2ee`, relays it as usual, sends
  pushes that say "New message", and fetches no link preview. Ciphertexts are padded, so they don't show
  the length of the text.
- Each browser decrypts a message once and keeps the text in IndexedDB (`videochat-e2ee-<userId>`),
  next to its private keys and group state. A browser without the prototype shows "🔒 Encrypted
  message".

## Safeguards

- Key packages are one-time, so claiming them is limited: members of the DM only, not across a
  block, never once the chat already has a group (409), and rate-limited per user
  (`RATE_LIMIT_E2EE_MAX` per `RATE_LIMIT_E2EE_WINDOW_SEC`, also on device registration and group
  creation).
- At most 10 active encryption devices per account; deleting an account deletes its devices, key
  packages and pending welcomes.
- Tabs of the same browser share one IndexedDB store, so every step that reads and writes MLS state
  runs under a Web Lock (`navigator.locks`) as well as an in-tab queue.
- A browser joins a group from a Welcome only if it is this chat's group, includes this account,
  and holds at most one other person.
- In an encrypted chat each message shows a lock or "Not encrypted": the other person may write
  from a phone or a browser without the prototype, and the server still accepts plain text there.

## Code

| Where                                  | What                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/shared/src/e2ee.ts`          | Schemas for the key directory and the `e2ee` message payload                            |
| `apps/api/src/e2ee/`                   | Key directory: devices, one-time key packages, groups, welcomes (`E2EE_PROTOTYPE` flag) |
| `apps/api/drizzle/0018_e2ee_spike.sql` | `e2ee_devices`, `e2ee_key_packages`, `e2ee_groups`, `e2ee_welcomes`                     |
| `apps/web/src/features/e2ee/mls.ts`    | The only file that talks to ts-mls (loaded lazily, ~32 KB gzip)                         |
| `apps/web/src/features/e2ee/client.ts` | Device registration, group create/join, encrypt/decrypt, local store                    |
| `apps/web/src/features/e2ee/index.ts`  | React hooks and the send helper used by the composer and the offline outbox             |

## Not in the prototype

Devices added after a chat's group exists (needs commits from an online member), removing devices,
group chats, attachments and voice messages (they stay unencrypted, and the chat header says so),
editing encrypted messages, safety-number verification, history on new devices, the phone apps,
MLS "last resort" key packages (a device that runs out can't be added until it tops up), and
clearing local keys and decrypted text from IndexedDB on sign-out (matters on shared computers).
