import { LIMITS, type Message } from '@videochat/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { sendMessage } from '../chat/messagesApi';
import { requestUpload, UploadError, uploadToStorage } from './attachmentsApi';

export interface PendingUpload {
  localId: string;
  conversationId: string;
  file: File;
  status: 'uploading' | 'sending' | 'failed';
  /** 0..1 while uploading. */
  progress: number;
  error?: string;
  /** Known once the server handed out an upload slot; lets a retry skip a finished upload. */
  attachmentId?: string;
  uploaded?: boolean;
  clientMsgId: string;
}

const MAX_MB = LIMITS.attachmentMaxBytes / (1024 * 1024);

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `u-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Sending too fast -- wait a moment and retry';
    if (error.status === 413 || error.status === 400) return error.message;
    return 'Couldn’t send -- retry';
  }
  if (error instanceof UploadError) return error.message;
  return 'Couldn’t send -- retry';
}

/**
 * CHAT-030: picks/drops/pastes become one message each: ask for an upload slot, PUT the bytes
 * to storage with progress (cancellable), then send the message that carries them. Files over
 * the limit are refused up front, before any bytes move.
 */
export function useAttachmentUploads(options: {
  conversationId: string | undefined;
  onSent: (message: Message) => void;
  onRejected: (reason: string) => void;
}) {
  const auth = useAuth();
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const patch = useCallback((localId: string, changes: Partial<PendingUpload>) => {
    setUploads((prev) => prev.map((u) => (u.localId === localId ? { ...u, ...changes } : u)));
  }, []);

  const run = useCallback(
    async (upload: PendingUpload) => {
      const controller = new AbortController();
      controllers.current.set(upload.localId, controller);
      let { attachmentId, uploaded } = upload;
      try {
        if (!attachmentId || !uploaded) {
          patch(upload.localId, { status: 'uploading', progress: 0, error: undefined });
          const slot = await withAuthRetry(auth, (token) =>
            requestUpload(token, upload.conversationId, {
              filename: upload.file.name || 'file',
              contentType: upload.file.type || 'application/octet-stream',
              sizeBytes: upload.file.size,
            }),
          );
          attachmentId = slot.attachmentId;
          patch(upload.localId, { attachmentId });
          await uploadToStorage(
            slot,
            upload.file,
            (progress) => patch(upload.localId, { progress }),
            controller.signal,
          );
          uploaded = true;
          patch(upload.localId, { uploaded: true });
        }
        if (controller.signal.aborted) throw new UploadError('Upload cancelled', true);
        patch(upload.localId, { status: 'sending', progress: 1 });
        const message = await withAuthRetry(auth, (token) =>
          sendMessage(token, upload.conversationId, {
            clientMsgId: upload.clientMsgId,
            attachmentId: attachmentId!,
          }),
        );
        setUploads((prev) => prev.filter((u) => u.localId !== upload.localId));
        optionsRef.current.onSent(message);
      } catch (error) {
        if (error instanceof UploadError && error.aborted) {
          setUploads((prev) => prev.filter((u) => u.localId !== upload.localId));
          return;
        }
        patch(upload.localId, { status: 'failed', error: describe(error) });
      } finally {
        controllers.current.delete(upload.localId);
      }
    },
    [auth, patch],
  );

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      const conversationId = optionsRef.current.conversationId;
      if (!conversationId) return;
      const accepted: PendingUpload[] = [];
      for (const file of files) {
        if (file.size === 0) {
          optionsRef.current.onRejected(`${file.name || 'That file'} is empty`);
          continue;
        }
        if (file.size > LIMITS.attachmentMaxBytes) {
          optionsRef.current.onRejected(
            `${file.name || 'That file'} is too big -- files can be up to ${MAX_MB} MB`,
          );
          continue;
        }
        accepted.push({
          localId: newId(),
          clientMsgId: newId(),
          conversationId,
          file,
          status: 'uploading',
          progress: 0,
        });
      }
      if (!accepted.length) return;
      setUploads((prev) => [...prev, ...accepted]);
      for (const upload of accepted) void run(upload);
    },
    [run],
  );

  const cancel = useCallback((localId: string) => {
    const controller = controllers.current.get(localId);
    if (controller) controller.abort();
    setUploads((prev) => prev.filter((u) => u.localId !== localId));
  }, []);

  const retry = useCallback(
    (localId: string) => {
      const upload = uploads.find((u) => u.localId === localId);
      if (upload) void run(upload);
    },
    [uploads, run],
  );

  // Leaving the page cancels whatever is still in flight.
  useEffect(() => {
    const map = controllers.current;
    return () => {
      for (const c of map.values()) c.abort();
    };
  }, []);

  return {
    uploads: uploads.filter((u) => u.conversationId === options.conversationId),
    addFiles,
    cancel,
    retry,
  };
}
