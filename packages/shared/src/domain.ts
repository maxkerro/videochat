/**
 * Domain enums shared by the database schema (apps/api), the API contract and the clients.
 * Keep these as `as const` tuples so they can back both Postgres enums and Zod enums.
 */
export const CONVERSATION_TYPES = ['direct', 'group'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const MEMBER_ROLES = ['admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** `call` (CHAT-044): a call's outcome, posted into the conversation when the call ends. */
export const MESSAGE_TYPES = ['text', 'image', 'file', 'system', 'call'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const DEVICE_PLATFORMS = ['web', 'ios', 'android'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const AUTH_TOKEN_PURPOSES = ['email_verify', 'password_reset'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/** Product limits referenced by both validation and UI. */
export const LIMITS = {
  messageMaxLength: 4000,
  usernameMin: 3,
  usernameMax: 30,
  displayNameMax: 64,
  groupTitleMax: 80,
  groupMaxMembers: 100,
  passwordMin: 8,
  passwordMax: 128,
  avatarMaxBytes: 5 * 1024 * 1024,
  /** Consecutive failed logins before a cool-down (CHAT-010). */
  loginAttemptsBeforeLockout: 5,
  loginLockoutMinutes: 15,
  /** Max rows returned by the "find people" search (CHAT-012). */
  userSearchMaxResults: 20,
  /** Messages returned by the initial (non-paged) history load (CHAT-014). Full cursor-based
   *  paging arrives with CHAT-016. */
  messageHistoryPageSize: 50,
  /** CHAT-072: the most a history page may hold when jumping back to a search result. */
  messageJumpPageSize: 200,
  /** Messages returned per round trip when catching up after a reconnect (CHAT-017's gap sync).
   *  Bounded, like the history page, but larger -- there's no scroll-jank concern to keep it small
   *  for, and a bigger page means fewer round trips for someone who was offline a while. */
  messageGapSyncPageSize: 200,
  /** CHAT-030: largest file a message can carry. */
  attachmentMaxBytes: 25 * 1024 * 1024,
  /** CHAT-030: longest edge of an image attachment's preview thumbnail, in px. */
  attachmentThumbMaxPx: 512,
  /** CHAT-032: how long after sending a message can still be edited. */
  messageEditWindowMinutes: 15,
  /** CHAT-032: how much of the original a reply quote carries. */
  replySnippetLength: 200,
  /** CHAT-033: distinct emoji one message can collect. */
  reactionsPerMessageMax: 20,
} as const;

/** CHAT-034/037: who can see when you're online and when you were last active. "contacts" =
 *  people you have a direct conversation with. */
export const LAST_SEEN_VISIBILITY = ['everyone', 'contacts', 'nobody'] as const;
export type LastSeenVisibility = (typeof LAST_SEEN_VISIBILITY)[number];

/** CHAT-037: the app's colour theme; "system" follows the OS. Synced across your devices. */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreferenceSetting = (typeof THEME_PREFERENCES)[number];

/** CHAT-034: a connection that hasn't refreshed its presence for this long counts as gone. */
export const PRESENCE_TTL_SECONDS = 60;

/** CHAT-033: the quick reactions offered first; any other emoji comes from the full picker. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/** CHAT-030: images get a thumbnail and open in the lightbox; anything else is a download card. */
export const ATTACHMENT_KINDS = ['image', 'file'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** CHAT-030: image types the server can decode, strip and thumbnail. Other images (HEIC, SVG,
 *  ...) are still accepted, just as plain files -- SVG deliberately so, since rendering one inline
 *  would be a script-injection vector. */
export const ATTACHMENT_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

/**
 * CHAT-074: voice messages are audio files with `voice` details (length, waveform), so an app
 * that predates them still shows a playable file. These are the recording formats the apps make
 * (Opus in WebM/Ogg from browsers, AAC in MP4 from Safari and the phones); the server checks the
 * bytes match before anyone can play them.
 */
export const VOICE_CONTENT_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
] as const;
export const VOICE = {
  maxSeconds: 300,
  /** 5 minutes at the apps' bit rates is well under 3 MB; this leaves room for any encoder. */
  maxBytes: 8 * 1024 * 1024,
  /** Bars in a voice message's waveform; each 0-100. */
  waveformBars: 48,
  /** Playback speeds offered, in order. */
  speeds: [1, 1.5, 2] as const,
} as const;

/** CHAT-041: what a call carries. An audio call can be upgraded by turning the camera on later. */
export const CALL_MEDIA = ['audio', 'video'] as const;
export type CallMedia = (typeof CALL_MEDIA)[number];

/** CHAT-041: a call's lifecycle. `ringing` until answered (or not), `active` while connected. */
export const CALL_STATUSES = ['ringing', 'active', 'ended'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/**
 * CHAT-041: why a call ended.
 * - `missed`: nobody answered within the ring timeout.
 * - `cancelled`: the caller hung up before it was answered.
 * - `declined`: the callee rejected it.
 * - `busy`: the callee was already in another call.
 * - `completed`: either side hung up an answered call.
 * - `connection-lost`: a participant's connection dropped and didn't come back in time.
 * - `unavailable`: the call couldn't be placed (not a direct chat, not a member, blocked).
 */
export const CALL_END_REASONS = [
  'missed',
  'cancelled',
  'declined',
  'busy',
  'completed',
  'connection-lost',
  'unavailable',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/**
 * CHAT-076 (spike): end-to-end encryption prototype limits. MLS messages and key packages travel
 * as base64 strings.
 */
export const E2EE = {
  /** Version of the `e2ee` payload on a message. */
  payloadVersion: 1,
  /** MLS cipher suite every device uses. */
  cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
  /** A 4,000-character message is about 12 KB of UTF-8, plus MLS framing, in base64. */
  maxCiphertextChars: 24_000,
  /** A key package or welcome is a few hundred bytes for a DM; this leaves room for big groups. */
  maxKeyPackageChars: 8_000,
  maxWelcomeChars: 200_000,
  /** Key packages uploaded per request, and kept per device at most. */
  keyPackagesPerUpload: 50,
  maxKeyPackagesPerDevice: 200,
  /** Devices a group can be created with in one go (members x devices). */
  maxWelcomesPerGroup: 200,
} as const;
