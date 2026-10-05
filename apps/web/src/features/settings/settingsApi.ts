import {
  meSchema,
  type ChangePasswordInput,
  type Me,
  type UpdateSettingsInput,
} from '@videochat/shared';
import { z } from 'zod';
import { API_URL, ApiError, apiPatch, apiPost } from '../../lib/api';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export function updateSettings(token: string, input: UpdateSettingsInput): Promise<Me> {
  return apiPatch('/me/settings', meSchema, input, { headers: auth(token) });
}

export function changePassword(token: string, input: ChangePasswordInput): Promise<unknown> {
  return apiPost('/auth/change-password', z.unknown(), input, { headers: auth(token) });
}

export function deleteAccount(token: string, password: string): Promise<unknown> {
  return apiPost('/auth/delete-account', z.unknown(), { password }, { headers: auth(token) });
}

/** Downloads the export as a file (the endpoint answers with the JSON itself). */
export async function downloadExport(token: string): Promise<void> {
  const res = await fetch(`${API_URL}/me/export`, { headers: auth(token), credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, 'Export failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `videochat-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
