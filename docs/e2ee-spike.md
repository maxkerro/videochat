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
editing encrypted messages, safety-number verification, history on new devices, and the phone apps.
