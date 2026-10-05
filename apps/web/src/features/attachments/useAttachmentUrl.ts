import { useQuery } from '@tanstack/react-query';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { fetchAttachmentUrl } from './attachmentsApi';

/** Signed URLs last 10 minutes (DOWNLOAD_URL_TTL_SEC); refetch a little before that. */
const STALE_MS = 8 * 60 * 1000;

/** CHAT-030: a signed URL for an attachment, cached briefly and refreshed before it expires. */
export function useAttachmentUrl(
  attachmentId: string,
  variant: 'original' | 'thumb',
  enabled = true,
) {
  const auth = useAuth();
  return useQuery({
    queryKey: ['attachment-url', attachmentId, variant],
    queryFn: async () =>
      (await withAuthRetry(auth, (token) => fetchAttachmentUrl(token, attachmentId, variant))).url,
    staleTime: STALE_MS,
    gcTime: STALE_MS,
    enabled: enabled && !!auth.accessToken,
    retry: 1,
  });
}
