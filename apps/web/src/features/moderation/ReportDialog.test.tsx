import type { Message } from '@videochat/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../components/ui';
import { ReportDialog } from './ReportDialog';

const reportMessage = vi.fn(async (..._args: unknown[]) => undefined);
const reportUser = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./moderationApi', () => ({
  reportMessage: (...a: unknown[]) => reportMessage(...a),
  reportUser: (...a: unknown[]) => reportUser(...a),
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ accessToken: 't' }),
  withAuthRetry: (_auth: unknown, fn: (token: string) => Promise<unknown>) => fn('t'),
}));
const decrypt = vi.fn(async () => ({ status: 'ok', text: 'the decrypted words' }));
vi.mock('../e2ee', () => ({ useE2ee: () => ({ decrypt }) }));

const message: Message = {
  id: '01J0000000000000000000000B',
  conversationId: '00000000-0000-4000-8000-0000000000d0',
  seq: 2,
  senderId: '00000000-0000-4000-8000-0000000000b0',
  clientMsgId: null,
  type: 'text',
  body: 'hello',
  replyToId: null,
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-10-17T10:00:00.000Z',
};

const renderDialog = (target: Parameters<typeof ReportDialog>[0]['target']) =>
  render(
    <ToastProvider>
      <ReportDialog target={target} onClose={() => undefined} />
    </ToastProvider>,
  );

beforeEach(() => vi.clearAllMocks());

describe('ReportDialog (CHAT-077)', () => {
  it('needs a reason, then reports the message', async () => {
    renderDialog({ kind: 'message', message, senderName: 'Ben' });
    const send = screen.getByRole('button', { name: 'Report' });
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'Spam or scam' }));
    await userEvent.type(screen.getByRole('textbox'), 'crypto scam');
    await userEvent.click(send);
    await waitFor(() => expect(reportMessage).toHaveBeenCalled());
    expect(reportMessage).toHaveBeenCalledWith('t', message.conversationId, message.id, {
      reason: 'spam',
      details: 'crypto scam',
    });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('sends what this browser decrypted for an encrypted message, and says so', async () => {
    renderDialog({
      kind: 'message',
      message: { ...message, body: null, e2ee: { v: 1, ciphertext: 'AA==' } },
      senderName: 'Ben',
    });
    expect(screen.getByText(/end-to-end encrypted: the text you see is sent/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Harassment or bullying' }));
    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    await waitFor(() => expect(reportMessage).toHaveBeenCalled());
    expect(reportMessage.mock.calls[0]![3]).toEqual({
      reason: 'harassment',
      decryptedText: 'the decrypted words',
    });
  });

  it('reports a person from the chat', async () => {
    renderDialog({
      kind: 'user',
      userId: message.senderId!,
      name: 'Ben',
      conversationId: message.conversationId,
    });
    expect(screen.getByRole('dialog', { name: 'Report Ben' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Something else' }));
    await userEvent.click(screen.getByRole('button', { name: 'Report' }));
    await waitFor(() =>
      expect(reportUser).toHaveBeenCalledWith('t', message.senderId, {
        reason: 'other',
        conversationId: message.conversationId,
      }),
    );
  });
});
