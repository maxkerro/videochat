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

- **Key packages can't be drained.** Each device also uploads one "last resort" key package
  (RFC 9420 §16.8): when its one-time packages run out, claims get that one, which is never used
  up. Claiming is limited to members of the DM, not across a block, never once the chat has a group
  (409), and rate-limited (`RATE_LIMIT_E2EE_MAX` per `RATE_LIMIT_E2EE_WINDOW_SEC`, also on device
  registration and group creation). Browsers top up one-time packages when fewer than 5 are left.
- **Devices.** At most 10 current devices per account (parallel registrations can't overshoot). A
  device not heard from in 30 days stops counting and isn't added to new chats; it comes back only
  while the account is under the limit. Settings -> Privacy -> "Remove my other encryption
  devices" removes the rest from the key directory: they aren't added to new chats and their key
  packages are deleted, **but they stay in chats they already joined** (removing a device from a
  chat's group is not built), so for a lost phone also change the password, which signs out other
  devices. A removed browser starts over as a new device on its next load, and **its decrypted
  history is gone** (only the key directory's own `e2ee_unknown_device` answer triggers this,
  never any other 403). Deleting an account removes its devices.
- **Last-resort packages** are replaced every 30 days; the previous one is kept until the next
  rotation for welcomes already on their way.
- **Turning it off or signing out** removes this browser's device on the server and permanently
  deletes its keys, group states and decrypted messages from IndexedDB (and switches the opt-in
  off). If the server can't be told (offline, session expired), the browser retries the next time
  that person signs in there.
- **Groups.** A group must include at least one device of the other person (otherwise the chat
  would be locked out of encryption). No group creation or welcome pickup across a block. A
  browser joins from a Welcome only if it is this chat's group, includes this account, and holds
  at most one other person.
- **Tabs** of one browser share an IndexedDB store, so every step that reads and writes MLS state
  runs under a Web Lock (`navigator.locks`) as well as an in-tab queue.
- **Never a silent downgrade.** With the prototype on, sending waits until the chat's type has
  loaded. In an encrypted chat each message shows a lock or "Not encrypted": the other person may
  write from a phone or a browser without the prototype, and the server still accepts plain text.

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

Devices added after a chat's group exists (needs commits from an online member), removing devices from chats they already joined,
group chats, attachments and voice messages (they stay unencrypted, and the chat header says so),
editing encrypted messages, safety-number verification, history on new devices, and the phone apps.
The last-resort package isn't marked with MLS's `last_resort` extension yet (the server keeps
track of it instead).
