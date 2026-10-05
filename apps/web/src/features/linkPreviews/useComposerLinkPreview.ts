import { useQuery } from '@tanstack/react-query';
import { firstUrl } from '@videochat/shared';
import { useEffect, useState } from 'react';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { fetchLinkPreview } from './linkPreviewsApi';

const DEBOUNCE_MS = 600;

/**
 * CHAT-031: the preview for the first URL in the composer, fetched once typing settles, so it can
 * be dismissed before sending. `dismissed` is per URL: typing a different link brings a preview
 * back.
 */
export function useComposerLinkPreview(draft: string) {
  const auth = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);

  useEffect(() => {
    const next = firstUrl(draft);
    const timer = setTimeout(() => setUrl(next), next ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [draft]);

  const query = useQuery({
    queryKey: ['link-preview', url],
    queryFn: () => withAuthRetry(auth, (token) => fetchLinkPreview(token, url!)),
    enabled: !!url && url !== dismissedUrl && !!auth.accessToken,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const currentUrl = firstUrl(draft);
  const dismissed = currentUrl !== null && currentUrl === dismissedUrl;
  return {
    preview: !dismissed && url === currentUrl ? (query.data ?? null) : null,
    /** False when the person dismissed the preview for the link in the draft. */
    wantsPreview: !dismissed,
    dismiss: () => setDismissedUrl(currentUrl),
    reset: () => setDismissedUrl(null),
  };
}
