import {
  E2EE_UNKNOWN_DEVICE,
  claimedKeyPackagesSchema,
  e2eeDeviceSchema,
  e2eeGroupSchema,
  e2eeWelcomesSchema,
  keyPackageCountSchema,
  revokedDevicesSchema,
  type ClaimedKeyPackages,
  type E2eeGroup,
  type E2eeWelcome,
} from '@videochat/shared';
import { z } from 'zod';
import { ApiError, apiDelete, apiGet, apiPost } from '../../lib/api';

/** CHAT-076 (spike): the key directory endpoints, as the client needs them. */
export interface E2eeApi {
  registerDevice(): Promise<{ deviceId: string }>;
  keyPackageCount(deviceId: string): Promise<number>;
  uploadKeyPackages(deviceId: string, keyPackages: string[], lastResort?: string): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  revokeOtherDevices(deviceId: string): Promise<number>;
  /** The server no longer knows this device (it was removed from another one). */
  isUnknownDevice(error: unknown): boolean;
  claim(conversationId: string, deviceId: string): Promise<ClaimedKeyPackages>;
  getGroup(conversationId: string): Promise<E2eeGroup | null>;
  /** Resolves false when another device created the group first (409). */
  createGroup(
    conversationId: string,
    deviceId: string,
    welcomes: { deviceId: string; welcome: string }[],
  ): Promise<boolean>;
  welcomes(deviceId: string): Promise<E2eeWelcome[]>;
  deleteWelcome(id: string): Promise<void>;
}

export function createHttpE2eeApi(
  withToken: <T>(fn: (token: string) => Promise<T>) => Promise<T>,
): E2eeApi {
  const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
  return {
    registerDevice: () => withToken((t) => apiPost('/e2ee/devices', e2eeDeviceSchema, {}, auth(t))),
    keyPackageCount: (deviceId) =>
      withToken((t) =>
        apiGet(`/e2ee/devices/${deviceId}/key-packages`, keyPackageCountSchema, auth(t)),
      ).then((r) => r.count),
    uploadKeyPackages: (deviceId, keyPackages, lastResort) =>
      withToken((t) =>
        apiPost(
          `/e2ee/devices/${deviceId}/key-packages`,
          keyPackageCountSchema,
          { keyPackages, ...(lastResort ? { lastResort } : {}) },
          auth(t),
        ),
      ).then(() => undefined),
    revokeDevice: (deviceId) =>
      withToken((t) => apiDelete(`/e2ee/devices/${deviceId}`, z.unknown(), auth(t))).then(
        () => undefined,
      ),
    revokeOtherDevices: (deviceId) =>
      withToken((t) =>
        apiPost(`/e2ee/devices/${deviceId}/revoke-others`, revokedDevicesSchema, {}, auth(t)),
      ).then((r) => r.revoked),
    // Only the key directory's own "unknown device" answer: any other 403 (a proxy, a future
    // guard) must never make a browser wipe its keys and decrypted history.
    isUnknownDevice: (error) =>
      error instanceof ApiError && error.status === 403 && error.code === E2EE_UNKNOWN_DEVICE,
    claim: (conversationId, deviceId) =>
      withToken((t) =>
        apiPost(
          `/e2ee/conversations/${conversationId}/key-packages/claim`,
          claimedKeyPackagesSchema,
          { deviceId },
          auth(t),
        ),
      ),
    getGroup: (conversationId) =>
      withToken((t) =>
        apiGet(
          `/e2ee/conversations/${conversationId}/group`,
          z.object({ group: e2eeGroupSchema.nullable() }),
          auth(t),
        ),
      ).then((r) => r.group),
    createGroup: (conversationId, deviceId, welcomes) =>
      withToken((t) =>
        apiPost(
          `/e2ee/conversations/${conversationId}/group`,
          e2eeGroupSchema,
          { deviceId, welcomes },
          auth(t),
        ),
      ).then(
        () => true,
        (error: unknown) => {
          if (error instanceof ApiError && error.status === 409) return false;
          throw error;
        },
      ),
    welcomes: (deviceId) =>
      withToken((t) =>
        apiGet(`/e2ee/welcomes?deviceId=${deviceId}`, e2eeWelcomesSchema, auth(t)),
      ).then((r) => r.welcomes),
    deleteWelcome: (id) =>
      withToken((t) => apiDelete(`/e2ee/welcomes/${id}`, z.unknown(), auth(t))).then(
        () => undefined,
      ),
  };
}
