import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useSignedImage } from './useSignedImage';

const fetchAttachmentUrl = vi.fn();
vi.mock('./attachmentsApi', () => ({
  fetchAttachmentUrl: (...args: unknown[]) => fetchAttachmentUrl(...args),
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ accessToken: 't' }),
  withAuthRetry: (_auth: unknown, fn: (token: string) => Promise<unknown>) => fn('t'),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** CHAT-082: a broken image ends in an error with Retry, after exactly one fresh URL. */
describe('useSignedImage', () => {
  let n = 0;
  const probe = vi.fn(async () => 'HTTP 403');
  beforeEach(() => {
    n = 0;
    vi.clearAllMocks();
    fetchAttachmentUrl.mockImplementation(async () => ({
      url: `https://bucket.test/a?sig=${++n}`,
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('is ready once the image loads', async () => {
    const { result } = renderHook(() => useSignedImage('att-1', 'thumb', true, probe), { wrapper });
    await waitFor(() => expect(result.current.src).toBe('https://bucket.test/a?sig=1'));
    expect(result.current.state).toBe('loading');
    act(() => result.current.onLoad());
    expect(result.current.state).toBe('ready');
  });

  it('refreshes an expired URL once, then shows an error (no refetch loop) and logs the status', async () => {
    const { result } = renderHook(() => useSignedImage('att-1', 'thumb', true, probe), { wrapper });
    await waitFor(() => expect(result.current.src).toBe('https://bucket.test/a?sig=1'));

    act(() => result.current.onError()); // the first URL failed: one fresh URL
    await waitFor(() => expect(result.current.src).toBe('https://bucket.test/a?sig=2'));
    expect(result.current.state).toBe('loading');

    act(() => result.current.onError()); // the fresh one failed too: give up
    expect(result.current.state).toBe('error');
    expect(result.current.src).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchAttachmentUrl).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('thumb image att-1 failed to load: HTTP 403'),
      ),
    );

    // Retry starts over: a new URL, and again one refresh allowed.
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.src).toBe('https://bucket.test/a?sig=3'));
    act(() => result.current.onLoad());
    expect(result.current.state).toBe('ready');
  });

  it('shows the error when the URL itself can’t be fetched', async () => {
    fetchAttachmentUrl.mockRejectedValue(new Error('index.html is not JSON'));
    const { result } = renderHook(() => useSignedImage('att-1', 'thumb', true, probe), { wrapper });
    // useAttachmentUrl retries once (about a second) before giving up.
    await waitFor(() => expect(result.current.state).toBe('error'), { timeout: 4000 });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("couldn't get a URL for thumb att-1"),
      expect.any(Error),
    );
  });
});
