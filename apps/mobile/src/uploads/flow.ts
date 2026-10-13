import {
  ApiError,
  createAttachmentUploadSchema,
  LIMITS,
  type AttachmentUpload,
  type CreateAttachmentUploadInput,
  type Message,
  type SendMessageInput,
} from '@videochat/shared';
import { UploadError, isNetworkError } from '../lib/errors';

export interface PickedFile {
  uri: string;
  name: string;
  contentType: string;
  /** May be unknown until the file is read. */
  sizeBytes: number | null;
  width?: number | null;
  height?: number | null;
}

/** A file read and (for photos) shrunk, ready to PUT. */
export interface PreparedFile<B = Blob> {
  blob: B;
  name: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadJob {
  id: string;
  conversationId: string;
  file: PickedFile;
  replyToId: string | null;
  /** Stable across retries, so a send that reached the server but whose answer was lost is not
   *  delivered twice. */
  clientMsgId: string;
}

/** What the flow keeps between attempts: a retry resumes where the last one stopped. */
export interface UploadProgress<B = Blob> {
  prepared: PreparedFile<B> | null;
  slot: AttachmentUpload | null;
  uploaded: boolean;
}

export type UploadPhase = 'preparing' | 'uploading' | 'sending';

export interface UploadDeps<B = Blob> {
  prepare: (file: PickedFile) => Promise<PreparedFile<B>>;
  requestUpload: (
    conversationId: string,
    input: CreateAttachmentUploadInput,
  ) => Promise<AttachmentUpload>;
  upload: (
    slot: AttachmentUpload,
    blob: B,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  send: (conversationId: string, input: SendMessageInput) => Promise<Message>;
  sleep: (ms: number) => Promise<void>;
}

export interface UploadHooks {
  onPhase: (phase: UploadPhase) => void;
  onProgress: (fraction: number) => void;
  /** Called before waiting to try again. */
  onRetry: (attempt: number, error: unknown) => void;
  signal?: AbortSignal;
}

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [1_000, 3_000];

/** A failure worth another try: no network, an expired link, or a server hiccup. A file that is too
 *  big or a request the server rejected will fail the same way again. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof UploadError) return e.retryable;
  if (e instanceof ApiError) return e.status >= 500 || e.status === 429;
  return isNetworkError(e);
}

export function newUploadProgress<B = Blob>(): UploadProgress<B> {
  return { prepared: null, slot: null, uploaded: false };
}

/**
 * One pass: read the file, ask for an upload slot, PUT the bytes, send the message. Each step is
 * skipped if an earlier attempt already finished it, and `progress` records how far we got.
 */
export async function attemptUpload<B>(
  job: UploadJob,
  deps: UploadDeps<B>,
  progress: UploadProgress<B>,
  hooks: UploadHooks,
): Promise<Message> {
  if (!progress.prepared) {
    hooks.onPhase('preparing');
    const prepared = await deps.prepare(job.file);
    // The bytes we will actually send, not the picker's idea of the size: the signed upload is
    // bound to the size we ask for.
    if (prepared.sizeBytes > LIMITS.attachmentMaxBytes) {
      throw new UploadError(`Files can be up to ${LIMITS.attachmentMaxBytes / (1024 * 1024)} MB.`);
    }
    if (prepared.sizeBytes === 0) throw new UploadError('That file is empty.');
    progress.prepared = prepared;
  }
  const { blob, name, contentType, sizeBytes } = progress.prepared;

  if (!progress.uploaded) {
    hooks.onPhase('uploading');
    if (!progress.slot) {
      const parsed = createAttachmentUploadSchema.safeParse({
        filename: name,
        contentType,
        sizeBytes,
      });
      if (!parsed.success) {
        throw new UploadError(parsed.error.issues[0]?.message ?? 'That file can’t be sent.');
      }
      progress.slot = await deps.requestUpload(job.conversationId, parsed.data);
    }
    try {
      await deps.upload(progress.slot, blob, hooks.onProgress, hooks.signal);
    } catch (e) {
      // The link may be what failed (expired, rejected): ask for a fresh one next time.
      progress.slot = null;
      throw e;
    }
    progress.uploaded = true;
  }

  // Cancelled (or the account changed) while the bytes were going up: do not post the message.
  if (hooks.signal?.aborted) throw new UploadError('Upload cancelled');
  hooks.onPhase('sending');
  return deps.send(job.conversationId, {
    clientMsgId: job.clientMsgId,
    attachmentId: progress.slot!.attachmentId,
    ...(job.replyToId ? { replyToId: job.replyToId } : {}),
  });
}

/** {@link attemptUpload} with up to {@link MAX_ATTEMPTS} tries, pausing between them. */
export async function runUpload<B>(
  job: UploadJob,
  deps: UploadDeps<B>,
  progress: UploadProgress<B>,
  hooks: UploadHooks,
): Promise<Message> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptUpload(job, deps, progress, hooks);
    } catch (e) {
      if (hooks.signal?.aborted || attempt >= MAX_ATTEMPTS || !isRetryable(e)) throw e;
      hooks.onRetry(attempt, e);
      await deps.sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!);
    }
  }
}
