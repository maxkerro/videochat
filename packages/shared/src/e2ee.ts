import { z } from 'zod';
import { E2EE } from './domain.js';

/**
 * CHAT-076 (spike): end-to-end encrypted messages with MLS (RFC 9420). The server stores and
 * relays public key material and ciphertext only; see docs/e2ee-spike.md.
 */

const base64 = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Expected base64');

/** The error `code` the key directory answers with (403) when it no longer knows a device:
 *  removed from another device, or gone quiet while the account is at its device limit. Only this
 *  tells a browser to wipe its keys and start over; any other 403 leaves them alone. */
export const E2EE_UNKNOWN_DEVICE = 'e2ee_unknown_device';

/** The encrypted form of a message: an MLS PrivateMessage, base64. Replaces `body`. */
export const e2eePayloadSchema = z.object({
  v: z.literal(E2EE.payloadVersion),
  ciphertext: base64(E2EE.maxCiphertextChars),
});
export type E2eePayload = z.infer<typeof e2eePayloadSchema>;

/** `POST /e2ee/devices`: register this device. Its id is part of its MLS identity, so key
 *  packages are uploaded right after, with that id inside them. */
export const registerE2eeDeviceSchema = z.object({});
export type RegisterE2eeDeviceInput = z.infer<typeof registerE2eeDeviceSchema>;

export const e2eeDeviceSchema = z.object({ deviceId: z.uuid(), userId: z.uuid() });
export type E2eeDevice = z.infer<typeof e2eeDeviceSchema>;

/** `POST /e2ee/devices/:deviceId/key-packages`: top up one-time key packages, and/or replace the
 *  device's last-resort package (RFC 9420 §16.8: handed out only when the one-time ones have run
 *  out, and never used up, so nobody can drain a device). */
export const uploadKeyPackagesSchema = z
  .object({
    keyPackages: z.array(base64(E2EE.maxKeyPackageChars)).max(E2EE.keyPackagesPerUpload),
    lastResort: base64(E2EE.maxKeyPackageChars).optional(),
  })
  .refine((v) => v.keyPackages.length > 0 || v.lastResort !== undefined, {
    message: 'Nothing to upload',
    path: ['keyPackages'],
  });
export type UploadKeyPackagesInput = z.infer<typeof uploadKeyPackagesSchema>;

export const keyPackageCountSchema = z.object({ count: z.number().int().nonnegative() });

/** `POST /e2ee/conversations/:id/key-packages/claim`: one key package per other device. */
export const claimKeyPackagesSchema = z.object({ deviceId: z.uuid() });
export type ClaimKeyPackagesInput = z.infer<typeof claimKeyPackagesSchema>;

export const claimedKeyPackagesSchema = z.object({
  keyPackages: z.array(
    z.object({
      userId: z.uuid(),
      deviceId: z.uuid(),
      keyPackage: z.string(),
      /** The device had run out of one-time packages; this is its reusable last resort. */
      lastResort: z.boolean().optional(),
    }),
  ),
  /** Devices with no key package at all (not even a last resort), so they can't be added. */
  missing: z.array(z.object({ userId: z.uuid(), deviceId: z.uuid() })),
});
export type ClaimedKeyPackages = z.infer<typeof claimedKeyPackagesSchema>;

/** `POST /e2ee/conversations/:id/group`: announce the conversation's MLS group. */
export const createE2eeGroupSchema = z.object({
  deviceId: z.uuid(),
  welcomes: z
    .array(z.object({ deviceId: z.uuid(), welcome: base64(E2EE.maxWelcomeChars) }))
    .max(E2EE.maxWelcomesPerGroup),
});
export type CreateE2eeGroupInput = z.infer<typeof createE2eeGroupSchema>;

export const e2eeGroupSchema = z.object({
  conversationId: z.uuid(),
  creatorDeviceId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type E2eeGroup = z.infer<typeof e2eeGroupSchema>;

/** `GET /e2ee/welcomes?deviceId=`: welcomes waiting for this device. */
export const welcomesQuerySchema = z.object({ deviceId: z.uuid() });

export const e2eeWelcomeSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  senderDeviceId: z.uuid().nullable(),
  welcome: z.string(),
  createdAt: z.iso.datetime(),
});
export const e2eeWelcomesSchema = z.object({ welcomes: z.array(e2eeWelcomeSchema) });
export type E2eeWelcome = z.infer<typeof e2eeWelcomeSchema>;

/** `GET /e2ee/status`: whether the server has the prototype switched on. */
export const e2eeStatusSchema = z.object({ enabled: z.boolean() });

/** `POST /e2ee/devices/:deviceId/revoke-others`: remove every other device of this account. */
export const revokedDevicesSchema = z.object({ revoked: z.number().int().nonnegative() });
