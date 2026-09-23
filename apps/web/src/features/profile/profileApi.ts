import {
  meSchema,
  updateProfileSchema,
  usernameAvailabilitySchema,
  type Me,
  type UpdateProfileInput,
} from '@videochat/shared';
import { apiGet, apiPatch, apiUpload } from '../../lib/api';

export function fetchMe(accessToken: string): Promise<Me> {
  return apiGet('/me', meSchema, { headers: { Authorization: `Bearer ${accessToken}` } });
}

export function updateProfile(accessToken: string, input: UpdateProfileInput): Promise<Me> {
  updateProfileSchema.parse(input);
  return apiPatch('/me', meSchema, input, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function checkUsernameAvailable(username: string): Promise<boolean> {
  return apiGet(
    `/users/username-availability?username=${encodeURIComponent(username)}`,
    usernameAvailabilitySchema,
  ).then((r) => r.available);
}

export function uploadAvatar(accessToken: string, file: File): Promise<Me> {
  const formData = new FormData();
  formData.append('avatar', file);
  return apiUpload('/me/avatar', meSchema, formData, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
