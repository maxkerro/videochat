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

/** The encrypted form of a message: an MLS PrivateMessage, base64. Replaces `body`. */
export const e2eePayloadSchema = z.object({
  v: z.literal(E2EE.payloadVersion),
  ciphertext: base64(E2EE.maxCiphertextChars),
});
export type E2eePayload = z.infer<typeof e2eePayloadSchema>;

const keyPackagesSchema = z
  .array(base64(E2EE.maxKeyPackageChars))
  .min(1)
  .max(E2EE.keyPackagesPerUpload);

/** `POST /e2ee/devices`: register this device. Its id is part of its MLS identity, so key
 *  packages are uploaded right after, with that id inside them. */
export const registerE2eeDeviceSchema = z.object({});
export type RegisterE2eeDeviceInput = z.infer<typeof registerE2eeDeviceSchema>;

export const e2eeDeviceSchema = z.object({ deviceId: z.uuid(), userId: z.uuid() });
export type E2eeDevice = z.infer<typeof e2eeDeviceSchema>;

/** `POST /e2ee/devices/:deviceId/key-packages`: top up one-time key packages. */
export const uploadKeyPackagesSchema = z.object({ keyPackages: keyPackagesSchema });
export type UploadKeyPackagesInput = z.infer<typeof uploadKeyPackagesSchema>;

export const keyPackageCountSchema = z.object({ count: z.number().int().nonnegative() });

/** `POST /e2ee/conversations/:id/key-packages/claim`: one key package per other device. */
export const claimKeyPackagesSchema = z.object({ deviceId: z.uuid() });
export type ClaimKeyPackagesInput = z.infer<typeof claimKeyPackagesSchema>;

export const claimedKeyPackagesSchema = z.object({
  keyPackages: z.array(z.object({ userId: z.uuid(), deviceId: z.uuid(), keyPackage: z.string() })),
  /** Devices that have run out of key packages (they can't be added until they top up). */
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
