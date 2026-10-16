import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { fetchAttachmentUrl } from '../attachments/attachmentsApi';
import { VoicePlaybackStore, type VoicePlaybackState } from './voicePlayback';

const Ctx = createContext<VoicePlaybackStore | null>(null);

/** CHAT-074: hosts the one audio element voice messages play through (see VoicePlaybackStore). */
export function VoicePlaybackProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [store] = useState(
    () => new VoicePlaybackStore(() => Promise.reject(new Error('Not signed in'))),
  );
  useEffect(() => {
    store.setUrlLoader((attachmentId, fresh) => {
      const queryKey = ['attachment-url', attachmentId, 'original'];
      if (fresh) queryClient.removeQueries({ queryKey });
      return queryClient.fetchQuery({
        queryKey,
        queryFn: async () =>
          (
            await withAuthRetry(auth, (token) =>
              fetchAttachmentUrl(token, attachmentId, 'original'),
            )
          ).url,
        staleTime: 8 * 60 * 1000,
      });
    });
  }, [store, auth, queryClient]);
  // Signing out stops whatever was playing.
  useEffect(() => {
    if (auth.status !== 'authenticated') store.stop();
  }, [auth.status, store]);
  useEffect(() => () => store.stop(), [store]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useVoicePlayback(): { store: VoicePlaybackStore; state: VoicePlaybackState } {
  const store = useContext(Ctx);
  if (!store) throw new Error('useVoicePlayback must be used inside <VoicePlaybackProvider>');
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, state };
}
