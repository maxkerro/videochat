import type { Message } from '@videochat/shared';
import { classifySendFailure } from '../chat/ChatPane';
import { E2eeUnavailableError, sendTextMessage } from './index';

vi.mock('../auth/AuthContext', () => ({
  useAuth: vi.fn(),
  withAuthRetry: (_auth: unknown, fn: (token: string) => Promise<unknown>) => fn('token'),
}));
const sendMessage = vi.fn(async (..._args: unknown[]) => ({ id: 'x' }) as unknown as Message);
vi.mock('../chat/messagesApi', () => ({
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

/** CHAT-076 (spike): an encrypted chat must never fall back to sending plain text. */
describe('sendTextMessage', () => {
  const auth = { accessToken: 't', refresh: async () => null, user: { id: 'u1' } };

  it('refuses, without sending anything, when encryption isn’t available here', async () => {
    // The prototype is off in this browser (no opt-in), yet the chat was meant to be encrypted.
    await expect(
      sendTextMessage(auth, 'conv', { clientMsgId: 'c1', body: 'secret' }, true),
    ).rejects.toBeInstanceOf(E2eeUnavailableError);
    expect(sendMessage).not.toHaveBeenCalled();
    // The composer shows it as an encryption failure (and keeps it out of the plain outbox).
    expect(classifySendFailure(new E2eeUnavailableError('x'))).toBe('encryption');
  });

  it('sends plain text only when the chat isn’t encrypted', async () => {
    await sendTextMessage(auth, 'conv', { clientMsgId: 'c2', body: 'hi' }, false);
    expect(sendMessage).toHaveBeenCalledWith('token', 'conv', { clientMsgId: 'c2', body: 'hi' });
  });
});
