import { useSyncExternalStore } from 'react';
import { session } from '../lib/api';
import { fetchAttachmentUrl } from '../data/api';
import { queryClient } from '../data/queryClient';
import { expoPlayer } from './expoAudio';
import { VoicePlayback } from './playback';

/** CHAT-074: the app-wide voice message player (see {@link VoicePlayback}). */
export const voicePlayback = new VoicePlayback(
  () => expoPlayer,
  (attachmentId, fresh) => {
    const queryKey = ['attachment-url', attachmentId, 'original'];
    if (fresh) queryClient.removeQueries({ queryKey });
    return queryClient
      .fetchQuery({
        queryKey,
        queryFn: () => fetchAttachmentUrl(attachmentId, 'original'),
        staleTime: 4 * 60_000,
      })
      .then((r) => r.url);
  },
);

// One account's voice messages never keep playing for the next.
session.onSignedOut(() => voicePlayback.stop());

export function useVoicePlayback() {
  return useSyncExternalStore(voicePlayback.subscribe, voicePlayback.getSnapshot);
}
