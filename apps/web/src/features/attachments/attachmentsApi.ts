import {
  attachmentUploadSchema,
  attachmentUrlSchema,
  type AttachmentUpload,
  type AttachmentUrl,
  type CreateAttachmentUploadInput,
} from '@videochat/shared';
import { apiGet, apiPost } from '../../lib/api';

function authHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

/** CHAT-030 step 1: somewhere to upload a file to before sending it. */
export function requestUpload(
  accessToken: string,
  conversationId: string,
  input: CreateAttachmentUploadInput,
): Promise<AttachmentUpload> {
  return apiPost(`/conversations/${conversationId}/attachments`, attachmentUploadSchema, input, {
    headers: authHeader(accessToken),
  });
}

/** A short-lived signed URL to show or download an attachment. */
export function fetchAttachmentUrl(
  accessToken: string,
  attachmentId: string,
  variant: 'original' | 'thumb',
): Promise<AttachmentUrl> {
  return apiGet(`/attachments/${attachmentId}/url?variant=${variant}`, attachmentUrlSchema, {
    headers: authHeader(accessToken),
  });
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly aborted = false,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * PUTs a file straight to object storage through the signed URL. XMLHttpRequest rather than
 * fetch: fetch still can't report upload progress. `signal` cancels it.
 */
export function uploadToStorage(
  upload: Pick<AttachmentUpload, 'uploadUrl' | 'uploadHeaders'>,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', upload.uploadUrl);
    for (const [name, value] of Object.entries(upload.uploadHeaders)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new UploadError(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new UploadError('Upload failed -- check your connection'));
    xhr.onabort = () => reject(new UploadError('Upload cancelled', true));
    if (signal) {
      if (signal.aborted) {
        reject(new UploadError('Upload cancelled', true));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
