import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ToastProvider } from '../../components/ui';
import { CallButtons } from './CallButtons';
import type { CallSnapshot } from './CallEngine';
import { CallOverlay } from './CallOverlay';
import { CallContext, endMessage, formatDuration, type CallController } from './CallProvider';

const PEER = { id: 'peer-1', displayName: 'Ben Peer', avatarUrl: null };

function snapshot(overrides: Partial<CallSnapshot> = {}): CallSnapshot {
  return {
    callId: 'call-1',
    conversationId: 'conv-1',
    peer: PEER,
    media: 'video',
    direction: 'outgoing',
    phase: 'active',
    calleeRinging: false,
    startedAt: Date.now() - 65_000,
    localStream: null,
    remoteStream: null,
    audioEnabled: true,
    videoEnabled: true,
    remoteAudioEnabled: true,
    remoteVideoEnabled: true,
    endCause: null,
    quality: 'good',
    lowBandwidth: false,
    ...overrides,
  };
}

function controller(call: CallSnapshot | null, overrides: Partial<CallController> = {}) {
  return {
    call,
    expanded: true,
    setExpanded: vi.fn(),
    startCall: vi.fn(),
    accept: vi.fn().mockResolvedValue(undefined),
    decline: vi.fn(),
    hangUp: vi.fn(),
    toggleAudio: vi.fn(),
    toggleVideo: vi.fn().mockResolvedValue(undefined),
    switchDevice: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } satisfies CallController;
}

function renderWith(ctrl: CallController, ui: ReactNode = <CallOverlay />, path = '/c/conv-1') {
  const router = createMemoryRouter(
    [
      { path: '/c/:id', element: ui },
      { path: '/', element: ui },
    ],
    { initialEntries: [path] },
  );
  render(
    <ToastProvider>
      <CallContext.Provider value={ctrl}>
        <RouterProvider router={router} />
      </CallContext.Provider>
    </ToastProvider>,
  );
  return router;
}

function stubMedia(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia), enumerateDevices: vi.fn().mockResolvedValue([]) },
  });
}

const fakeStream = () =>
  ({
    getTracks: () => [],
    getVideoTracks: () => [],
    getAudioTracks: () => [],
  }) as unknown as MediaStream;

describe('call UI (CHAT-042)', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  describe('incoming call', () => {
    it('shows who is calling with accept/decline, and declines on request', async () => {
      const ctrl = controller(
        snapshot({ phase: 'incoming', direction: 'incoming', startedAt: null }),
      );
      renderWith(ctrl);

      expect(
        await screen.findByRole('dialog', { name: 'Incoming video call' }),
      ).toBeInTheDocument();
      expect(screen.getByText('Ben Peer is calling you')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
      expect(ctrl.decline).toHaveBeenCalled();
    });

    it('answers with the camera and microphone', async () => {
      const stream = fakeStream();
      stubMedia(() => Promise.resolve(stream));
      const ctrl = controller(
        snapshot({ phase: 'incoming', direction: 'incoming', startedAt: null }),
      );
      renderWith(ctrl);

      await userEvent.click(await screen.findByRole('button', { name: 'Answer' }));

      await waitFor(() => expect(ctrl.accept).toHaveBeenCalledWith(stream));
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({ video: expect.anything(), audio: expect.anything() }),
      );
    });

    it('explains a blocked camera instead of answering, and keeps ringing', async () => {
      stubMedia(() =>
        Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
      );
      const ctrl = controller(
        snapshot({ phase: 'incoming', direction: 'incoming', startedAt: null }),
      );
      renderWith(ctrl);

      await userEvent.click(await screen.findByRole('button', { name: 'Answer' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/blocked/i);
      expect(ctrl.accept).not.toHaveBeenCalled();
      expect(ctrl.decline).not.toHaveBeenCalled();
    });
  });

  describe('in a call', () => {
    it("shows the timer and the other side's mute state", () => {
      renderWith(controller(snapshot({ remoteAudioEnabled: false })));
      expect(screen.getByRole('status')).toHaveTextContent('1:05');
      expect(screen.getByText('Ben Peer is muted')).toBeInTheDocument();
    });

    it('shows "Ringing…" while the callee\'s device rings', () => {
      renderWith(controller(snapshot({ phase: 'outgoing', calleeRinging: true, startedAt: null })));
      expect(screen.getByRole('status')).toHaveTextContent('Ringing…');
      expect(screen.getByRole('button', { name: 'Cancel call' })).toBeInTheDocument();
    });

    it('mute, camera and hang up buttons drive the call', async () => {
      const ctrl = controller(snapshot());
      renderWith(ctrl);
      await userEvent.click(screen.getByRole('button', { name: 'Mute microphone (M)' }));
      await userEvent.click(screen.getByRole('button', { name: 'Turn camera off (V)' }));
      await userEvent.click(screen.getByRole('button', { name: 'Hang up' }));
      expect(ctrl.toggleAudio).toHaveBeenCalled();
      expect(ctrl.toggleVideo).toHaveBeenCalled();
      expect(ctrl.hangUp).toHaveBeenCalled();
    });

    it('reflects mute/camera state on the buttons', () => {
      renderWith(controller(snapshot({ audioEnabled: false, videoEnabled: false })));
      expect(screen.getByRole('button', { name: 'Unmute microphone (M)' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Turn camera on (V)' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByText('Camera off')).toBeInTheDocument();
    });

    it('M and V toggle mute and camera, but not while typing in a text field', () => {
      const ctrl = controller(snapshot());
      renderWith(ctrl);

      fireEvent.keyDown(window, { key: 'm' });
      fireEvent.keyDown(window, { key: 'V' });
      expect(ctrl.toggleAudio).toHaveBeenCalledTimes(1);
      expect(ctrl.toggleVideo).toHaveBeenCalledTimes(1);

      const input = document.createElement('textarea');
      document.body.append(input);
      fireEvent.keyDown(input, { key: 'm' });
      expect(ctrl.toggleAudio).toHaveBeenCalledTimes(1);
      input.remove();
    });

    it('minimises to a bar that keeps mute/hang up and links back to the call', async () => {
      const ctrl = controller(snapshot(), { expanded: false });
      renderWith(ctrl, <CallOverlay />, '/c/other-conv');

      const bar = screen.getByRole('region', { name: 'Call with Ben Peer' });
      expect(bar).toHaveTextContent('1:05');
      await userEvent.click(screen.getByRole('button', { name: 'Hang up' }));
      expect(ctrl.hangUp).toHaveBeenCalled();
      expect(screen.getByRole('link', { name: 'Return to call' })).toHaveAttribute(
        'href',
        '/c/conv-1',
      );
    });

    it('navigating to another chat minimises the call instead of ending it', async () => {
      const ctrl = controller(snapshot());
      const router = renderWith(ctrl);
      await act(() => router.navigate('/c/other-conv'));
      expect(ctrl.setExpanded).toHaveBeenCalledWith(false);
      expect(ctrl.hangUp).not.toHaveBeenCalled();
    });

    // CHAT-043
    it('covers the call with a reconnecting overlay while the connection recovers', () => {
      renderWith(controller(snapshot({ phase: 'reconnecting' })));
      expect(screen.getByRole('alert')).toHaveTextContent('Reconnecting…');
      expect(screen.getByRole('alert')).toHaveTextContent(/15 seconds/);
    });

    it('shows a poor-connection indicator', () => {
      renderWith(controller(snapshot({ quality: 'poor' })));
      expect(screen.getByText('Poor connection')).toBeInTheDocument();
    });

    it('suggests switching to audio only when bandwidth is too low', async () => {
      const ctrl = controller(snapshot({ lowBandwidth: true }));
      renderWith(ctrl);
      await userEvent.click(screen.getByRole('button', { name: 'Switch to audio only' }));
      expect(ctrl.toggleVideo).toHaveBeenCalled();
    });

    it('the self view can be dragged', () => {
      renderWith(controller(snapshot()));
      const self = screen.getByTestId('call-self-view');
      expect(self).toHaveStyle({ right: '16px', bottom: '16px' });
      fireEvent.pointerDown(self, { clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(self, { clientX: 90, clientY: 95, pointerId: 1 });
      fireEvent.pointerUp(self, { pointerId: 1 });
      // jsdom does no layout, so the drag is clamped to the stage's (0-size) bounds -- what
      // matters here is that dragging updates the position at all.
      expect(self.style.right).not.toBe('16px');
    });
  });

  describe('starting a call from a direct chat', () => {
    it('runs a pre-join device check, then places the call with that stream', async () => {
      const stream = fakeStream();
      stubMedia(() => Promise.resolve(stream));
      const ctrl = controller(null);
      renderWith(ctrl, <CallButtons peer={PEER} conversationId="conv-1" />);

      await userEvent.click(screen.getByRole('button', { name: 'Start video call with Ben Peer' }));
      const dialog = await screen.findByRole('dialog', { name: 'Start video call with Ben Peer' });
      const call = await screen.findByRole('button', { name: 'Call' });
      await waitFor(() => expect(call).toBeEnabled());
      await userEvent.click(call);

      expect(dialog).not.toBeInTheDocument();
      expect(ctrl.startCall).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        peer: PEER,
        media: 'video',
        stream,
      });
    });

    it('explains a blocked microphone and does not place the call', async () => {
      stubMedia(() =>
        Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
      );
      const ctrl = controller(null);
      renderWith(ctrl, <CallButtons peer={PEER} conversationId="conv-1" />);

      await userEvent.click(screen.getByRole('button', { name: 'Start audio call with Ben Peer' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/microphone is blocked/i);
      expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
    });

    it('is disabled while already in a call', () => {
      stubMedia(() => Promise.resolve(fakeStream()));
      renderWith(controller(snapshot()), <CallButtons peer={PEER} conversationId="conv-2" />);
      expect(
        screen.getByRole('button', { name: 'Start video call with Ben Peer (already in a call)' }),
      ).toBeDisabled();
    });
  });

  describe('how a call ended', () => {
    const call = { direction: 'outgoing' as const, peer: PEER, startedAt: 0 };
    it("describes each outcome from the caller's side", () => {
      expect(endMessage(call, 'missed', 0)).toBe('Ben Peer didn’t answer');
      expect(endMessage(call, 'declined', 0)).toBe('Ben Peer declined the call');
      expect(endMessage(call, 'busy', 0)).toBe('Ben Peer is on another call');
      expect(endMessage(call, 'completed', 125_000)).toBe('Call ended · 2:05');
    });
    it('describes a missed call to the callee, and says nothing after declining', () => {
      const incoming = { ...call, direction: 'incoming' as const };
      expect(endMessage(incoming, 'cancelled', 0)).toBe('Missed call from Ben Peer');
      expect(endMessage(incoming, 'declined', 0)).toBeNull();
    });
    it('formats durations', () => {
      expect(formatDuration(5_000)).toBe('0:05');
      expect(formatDuration(3_725_000)).toBe('1:02:05');
    });
  });
});
