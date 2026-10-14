import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GroupCall } from '@videochat/shared';
import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { GroupCallBanner, GroupCallButton } from './GroupCallBar';
import { GroupCallContext, joinErrorText, type GroupCallController } from './GroupCallProvider';
import { participantsText } from './useRunningGroupCall';

let running: GroupCall | null = null;
vi.mock('./useRunningGroupCall', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useRunningGroupCall')>()),
  useRunningGroupCall: () => running,
}));

const CONV = '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c';
const call = (participantCount: number): GroupCall => ({
  id: '11111111-1111-4111-8111-111111111111',
  conversationId: CONV,
  startedBy: null,
  startedAt: new Date().toISOString(),
  participantCount,
});

function controller(overrides: Partial<GroupCallController> = {}): GroupCallController {
  return {
    session: null,
    joining: null,
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    ...overrides,
  };
}

function renderWith(ctrl: GroupCallController, ui: ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GroupCallContext.Provider value={ctrl}>{ui}</GroupCallContext.Provider>
    </QueryClientProvider>,
  );
}

describe('group calls (CHAT-070)', () => {
  beforeEach(() => {
    running = null;
  });

  it('offers to start a group call when none is running', async () => {
    const ctrl = controller();
    renderWith(ctrl, <GroupCallButton conversationId={CONV} title="Team" />);
    await userEvent.click(screen.getByRole('button', { name: 'Group call' }));
    expect(ctrl.join).toHaveBeenCalledWith(CONV, 'Team');
  });

  it('lets a late joiner join the running call from the chat', async () => {
    running = call(3);
    const ctrl = controller();
    renderWith(
      ctrl,
      <>
        <GroupCallButton conversationId={CONV} title="Team" />
        <GroupCallBanner conversationId={CONV} title="Team" />
      </>,
    );
    expect(screen.queryByRole('button', { name: 'Group call' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('3 people in the call');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(ctrl.join).toHaveBeenCalledWith(CONV, 'Team');
  });

  it('says you are in it instead of offering to join again', () => {
    running = call(2);
    renderWith(
      controller({
        session: { callId: 'x', conversationId: CONV, title: 'Team', url: 'wss://x', token: 't' },
      }),
      <GroupCallBanner conversationId={CONV} title="Team" />,
    );
    expect(screen.getByText('You’re in this call')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
  });

  it('cannot join while already in another group call', () => {
    running = call(2);
    renderWith(
      controller({
        session: {
          callId: 'y',
          conversationId: 'other',
          title: 'Other',
          url: 'wss://x',
          token: 't',
        },
      }),
      <GroupCallBanner conversationId={CONV} title="Team" />,
    );
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
  });

  it('words the call and the errors', () => {
    expect(participantsText(call(0))).toBe('Starting…');
    expect(participantsText(call(1))).toBe('1 person in the call');
    expect(participantsText(call(5))).toBe('5 people in the call');
    expect(joinErrorText(new ApiError(409, 'The call is full (20 people at most)'))).toMatch(
      /full/,
    );
    expect(joinErrorText(new ApiError(503, 'x'))).toMatch(/aren’t available/);
    expect(joinErrorText(new Error('boom'))).toMatch(/Couldn’t join/);
  });
});
