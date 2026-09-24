/**
 * Domain enums shared by the database schema (apps/api), the API contract and the clients.
 * Keep these as `as const` tuples so they can back both Postgres enums and Zod enums.
 */
export const CONVERSATION_TYPES = ['direct', 'group'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const MEMBER_ROLES = ['admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MESSAGE_TYPES = ['text', 'image', 'file', 'system'] as const;
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
} as const;
