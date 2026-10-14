import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { ToastProvider } from '../../components/ui';
import { GroupCallProvider, useGroupCall } from './GroupCallProvider';

const auth = vi.hoisted(() => ({
  current: { status: 'authenticated', user: { id: 'anna' } as { id: string } | null },
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ ...auth.current, accessToken: 'at', refresh: vi.fn() }),
  withAuthRetry: (_a: unknown, send: (t: string) => Promise<unknown>) => send('at'),
}));
vi.mock('../calls/CallProvider', () => ({ useCalls: () => ({ call: null }) }));
vi.mock('./groupCallsApi', () => ({
  joinGroupCall: vi.fn(async () => ({
    call: { id: 'call-1' },
    url: 'wss://sfu.test',
    token: 'anna-token',
  })),
}));
vi.mock('./GroupCallView', () => ({
  default: ({ session }: { session: { token: string } }) => (
    <div data-testid="call-view">{session.token}</div>
  ),
}));

const grabbed: { current: ReturnType<typeof useGroupCall> | null } = { current: null };
function Grab() {
  const ctrl = useGroupCall();
  useEffect(() => {
    grabbed.current = ctrl;
  });
  return null;
}
const controller = () => grabbed.current!;

function renderProvider() {
  return render(
    <ToastProvider>
      <GroupCallProvider>
        <Grab />
      </GroupCallProvider>
    </ToastProvider>,
  );
}

function rerenderWith(view: ReturnType<typeof render>) {
  view.rerender(
    <ToastProvider>
      <GroupCallProvider>
        <Grab />
      </GroupCallProvider>
    </ToastProvider>,
  );
}

describe('GroupCallProvider (CHAT-070)', () => {
  beforeEach(() => {
    auth.current = { status: 'authenticated', user: { id: 'anna' } };
  });

  it('keeps the call through a moment without a known user while still signed in', async () => {
    const view = renderProvider();
    await act(() => controller().join('conv-1', 'Team'));
    expect(await screen.findByTestId('call-view')).toBeInTheDocument();
    auth.current = { status: 'loading', user: null };
    rerenderWith(view);
    auth.current = { status: 'authenticated', user: { id: 'anna' } };
    rerenderWith(view);
    expect(screen.getByTestId('call-view')).toHaveTextContent('anna-token');
  });

  it('never hands one person’s call to the next person signing in on the same tab', async () => {
    const view = renderProvider();
    await act(() => controller().join('conv-1', 'Team'));
    expect(await screen.findByTestId('call-view')).toHaveTextContent('anna-token');

    auth.current = { status: 'anonymous', user: null };
    view.rerender(
      <ToastProvider>
        <GroupCallProvider>
          <Grab />
        </GroupCallProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('call-view')).not.toBeInTheDocument());

    auth.current = { status: 'authenticated', user: { id: 'ben' } };
    view.rerender(
      <ToastProvider>
        <GroupCallProvider>
          <Grab />
        </GroupCallProvider>
      </ToastProvider>,
    );
    expect(screen.queryByTestId('call-view')).not.toBeInTheDocument();
    expect(controller().session).toBeNull();

    // Nor does it come back when the first person signs in again.
    auth.current = { status: 'authenticated', user: { id: 'anna' } };
    view.rerender(
      <ToastProvider>
        <GroupCallProvider>
          <Grab />
        </GroupCallProvider>
      </ToastProvider>,
    );
    expect(screen.queryByTestId('call-view')).not.toBeInTheDocument();
  });
});
