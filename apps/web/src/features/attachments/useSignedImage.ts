import { useCallback, useEffect, useState } from 'react';
import { useAttachmentUrl } from './useAttachmentUrl';

export type SignedImageState = 'loading' | 'ready' | 'error';

/**
 * CHAT-082: an image behind a short-lived signed URL, as an `<img>` source plus what to show.
 *
 * - When the image fails to load, the signed URL is fetched again **once** (it may simply have
 *   expired while the tab sat open). If the fresh URL fails too -- or the URL request itself
 *   fails -- the state is `error`, and nothing is retried until the person presses Retry. The old
 *   `onError -> refetch` ran forever when the image (not the URL) was the problem.
 * - Every failure is logged to the console with what we can find out about it, so a broken image
 *   is diagnosable from DevTools instead of being an endless grey placeholder.
 */
export function useSignedImage(
  attachmentId: string,
  variant: 'original' | 'thumb',
  enabled = true,
  probe: (url: string) => Promise<string> = probeImage,
) {
  const url = useAttachmentUrl(attachmentId, variant, enabled);
  /** The URL that has already been replaced once: a failure of its replacement is final. */
  const [refreshedFrom, setRefreshedFrom] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);

  const src = url.data ?? null;
  const state: SignedImageState =
    url.isError || (src !== null && failedUrl === src)
      ? 'error'
      : src !== null && loadedUrl === src
        ? 'ready'
        : 'loading';

  const onError = useCallback(() => {
    if (!src) return;
    void probe(src).then((detail) =>
      console.warn(`[attachments] ${variant} image ${attachmentId} failed to load: ${detail}`),
    );
    if (refreshedFrom === null) {
      // First failure: maybe just an expired signature. One fresh URL, then give up.
      setRefreshedFrom(src);
      void url.refetch();
    } else {
      setFailedUrl(src);
    }
  }, [attachmentId, variant, src, refreshedFrom, url, probe]);

  const onLoad = useCallback(() => {
    if (src) setLoadedUrl(src);
  }, [src]);

  const retry = useCallback(() => {
    setRefreshedFrom(null);
    setFailedUrl(null);
    void url.refetch();
  }, [url]);

  const urlError = url.isError ? url.error : null;
  useEffect(() => {
    if (urlError) {
      console.warn(`[attachments] couldn't get a URL for ${variant} ${attachmentId}:`, urlError);
    }
  }, [urlError, variant, attachmentId]);

  return { src: state === 'error' ? null : src, state, onError, onLoad, retry };
}

/** Best effort: the HTTP status of the image request (an `<img>` error event doesn't say). */
export async function probeImage(url: string): Promise<string> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return `HTTP ${res.status}${res.ok ? ' (the response looked fine: not an image, or blocked by the browser?)' : ''}`;
  } catch (err) {
    return `request failed (${err instanceof Error ? err.message : String(err)}), likely CORS or network`;
  }
}
