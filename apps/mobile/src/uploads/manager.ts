import type { Message } from '@videochat/shared';
import {
  newUploadProgress,
  runUpload,
  type PickedFile,
  type UploadDeps,
  type UploadJob,
  type UploadPhase,
  type UploadProgress,
} from './flow';

/** What the chat screen shows for a file that is on its way (or has failed to get there). */
export interface UploadEntry {
  id: string;
  conversationId: string;
  file: PickedFile;
  replyToId: string | null;
  status: 'uploading' | 'failed';
  phase: UploadPhase;
  /** 0..1 while the bytes go up. */
  progress: number;
  /** Set when the last attempt failed and was not retried automatically. */
  error: string | null;
  /** Set between automatic retries ("Retrying…"). */
  retrying: boolean;
}

export interface UploadManagerOptions<B> {
  deps: UploadDeps<B>;
  newId: () => string;
  /** The current session generation: a file belongs to the account that picked it. */
  generation: () => number;
  /** Puts the sent message in the on-screen list and the on-device copy. */
  record: (message: Message, generation: number) => Promise<void>;
  describeError: (e: unknown) => string;
}

interface Running<B> {
  job: UploadJob;
  progress: UploadProgress<B>;
  controller: AbortController;
  generation: number;
}

/**
 * CHAT-056: uploads live here, not in a screen. Leaving the chat (or the app going to another
 * screen) does not stop them; they finish in the background of the running app, retry on their
 * own a couple of times, and otherwise wait as "failed" for a tap on Retry. Signing out cancels
 * everything, so one account's files are never sent as another's.
 */
export function createUploadManager<B>(options: UploadManagerOptions<B>) {
  let entries: UploadEntry[] = [];
  const running = new Map<string, Running<B>>();
  const listeners = new Set<() => void>();

  function emit() {
    for (const l of listeners) l();
  }
  function update(id: string, patch: Partial<UploadEntry>) {
    if (!entries.some((e) => e.id === id)) return;
    entries = entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
    emit();
  }
  function remove(id: string) {
    running.delete(id);
    if (entries.some((e) => e.id === id)) {
      entries = entries.filter((e) => e.id !== id);
      emit();
    }
  }

  async function run(id: string): Promise<void> {
    const r = running.get(id);
    if (!r) return;
    update(id, { status: 'uploading', error: null, retrying: false, progress: 0 });
    try {
      const message = await runUpload(r.job, options.deps, r.progress, {
        signal: r.controller.signal,
        onPhase: (phase) => update(id, { phase }),
        onProgress: (fraction) => update(id, { progress: fraction }),
        onRetry: () => update(id, { retrying: true, progress: 0 }),
      });
      // Record first, then drop the bubble: the real message is already on screen when it goes, so
      // the list never shows a gap.
      try {
        await options.record(message, r.generation);
      } finally {
        remove(id);
      }
    } catch (e) {
      if (r.controller.signal.aborted) {
        remove(id);
        return;
      }
      update(id, { status: 'failed', error: options.describeError(e), retrying: false });
    }
  }

  return {
    /** Starts sending a picked file into a conversation. Returns the entry's id. */
    start(conversationId: string, file: PickedFile, opts: { replyToId?: string | null } = {}) {
      const id = options.newId();
      const job: UploadJob = {
        id,
        conversationId,
        file,
        replyToId: opts.replyToId ?? null,
        clientMsgId: options.newId(),
      };
      running.set(id, {
        job,
        progress: newUploadProgress<B>(),
        controller: new AbortController(),
        generation: options.generation(),
      });
      entries = [
        ...entries,
        {
          id,
          conversationId,
          file,
          replyToId: job.replyToId,
          status: 'uploading',
          phase: 'preparing',
          progress: 0,
          error: null,
          retrying: false,
        },
      ];
      emit();
      void run(id);
      return id;
    },
    /** Tries a failed upload again, picking up where it stopped. */
    retry(id: string) {
      const r = running.get(id);
      const entry = entries.find((e) => e.id === id);
      if (!r || entry?.status !== 'failed') return;
      void run(id);
    },
    /** Cancels an upload in flight, or drops a failed one. */
    discard(id: string) {
      running.get(id)?.controller.abort();
      remove(id);
    },
    /** Cancels everything (sign-out). */
    clear() {
      for (const r of running.values()) r.controller.abort();
      running.clear();
      if (entries.length) {
        entries = [];
        emit();
      }
    },
    getSnapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
