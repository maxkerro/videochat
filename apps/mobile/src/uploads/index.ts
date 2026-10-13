import { useMemo, useSyncExternalStore } from 'react';
import { prepareFile } from '../chat/prepareFile';
import { recordMessage, newClientMsgId } from '../data/outboxRunner';
import { requestUpload, sendMessage, uploadToStorage } from '../data/api';
import { session } from '../lib/api';
import { describeError } from '../ui/describeError';
import { createUploadManager, type UploadEntry } from './manager';

/** The app-wide upload manager (see {@link createUploadManager}). */
export const uploads = createUploadManager<Blob>({
  deps: {
    prepare: prepareFile,
    requestUpload,
    upload: uploadToStorage,
    send: sendMessage,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
  newId: newClientMsgId,
  generation: () => session.generation(),
  record: recordMessage,
  describeError,
});

// A file picked by one account must never be sent as another's.
session.onSignedOut(() => uploads.clear());

/** The uploads in progress (or failed) for one conversation, oldest first. */
export function useConversationUploads(conversationId: string): UploadEntry[] {
  const all = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
  return useMemo(
    () => all.filter((u) => u.conversationId === conversationId),
    [all, conversationId],
  );
}
