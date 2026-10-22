import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../components/ui';
import { AttachmentView } from './AttachmentView';

let n = 0;
const fetchAttachmentUrl = vi.fn(async () => ({ url: `https://bucket.test/thumb?sig=${++n}` }));
vi.mock('./attachmentsApi', async (orig) => ({
  ...(await orig<typeof import('./attachmentsApi')>()),
  fetchAttachmentUrl: () => fetchAttachmentUrl(),
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ accessToken: 't' }),
  withAuthRetry: (_auth: unknown, fn: (token: string) => Promise<unknown>) => fn('t'),
}));

/** CHAT-082: a photo that can't load ends in a visible error with Retry, after one fresh URL. */
describe('AttachmentView image', () => {
  beforeEach(() => {
    n = 0;
    fetchAttachmentUrl.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows an error with Retry instead of an endless placeholder', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <AttachmentView
            attachment={{
              id: '00000000-0000-4000-8000-000000000001',
              kind: 'image',
              filename: 'cat.jpg',
              contentType: 'image/jpeg',
              sizeBytes: 1000,
              width: 400,
              height: 300,
            }}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    fireEvent.error(await screen.findByRole('img', { name: 'cat.jpg' }));
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'cat.jpg' })).toHaveAttribute(
        'src',
        'https://bucket.test/thumb?sig=2',
      ),
    );
    fireEvent.error(screen.getByRole('img', { name: 'cat.jpg' }));
    expect(await screen.findByText('Couldn’t load this photo.')).toBeInTheDocument();
    expect(fetchAttachmentUrl).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 403')),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const img = await screen.findByRole('img', { name: 'cat.jpg' });
    expect(img).toHaveAttribute('src', 'https://bucket.test/thumb?sig=3');
  });
});
