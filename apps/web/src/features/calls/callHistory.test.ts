import type { CallMessageMeta } from '@videochat/shared';
import { previewFor } from '../conversations/ConversationList';
import { callHistoryText, isMissedByMe } from './callHistory';

const ME = 'me';
const THEM = 'them';
const meta = (overrides: Partial<CallMessageMeta>): CallMessageMeta => ({
  callId: '11111111-1111-4111-8111-111111111111',
  media: 'video',
  outcome: 'completed',
  endReason: 'completed',
  callerId: ME,
  durationSec: 754,
  ...overrides,
});

describe('call history wording (CHAT-044)', () => {
  it('shows the duration of a completed call to both sides', () => {
    expect(callHistoryText(meta({}), ME)).toBe('Video call · 12:34');
    expect(callHistoryText(meta({}), THEM)).toBe('Video call · 12:34');
  });

  it('words an unanswered call from each side', () => {
    const missed = meta({ outcome: 'missed', endReason: 'missed', durationSec: null });
    expect(callHistoryText(missed, THEM)).toBe('Missed video call');
    expect(callHistoryText(missed, ME)).toBe('Video call · No answer');
    expect(isMissedByMe(missed, THEM)).toBe(true);
    expect(isMissedByMe(missed, ME)).toBe(false);
  });

  it('distinguishes a cancelled or busy call for the caller', () => {
    expect(
      callHistoryText(meta({ outcome: 'missed', endReason: 'cancelled', media: 'audio' }), ME),
    ).toBe('Cancelled audio call');
    expect(callHistoryText(meta({ outcome: 'missed', endReason: 'busy' }), ME)).toBe(
      'Video call · Busy',
    );
  });

  it('words a declined call from each side', () => {
    const declined = meta({ outcome: 'declined', endReason: 'declined', durationSec: null });
    expect(callHistoryText(declined, ME)).toBe('Video call · Declined');
    expect(callHistoryText(declined, THEM)).toBe('Declined video call');
  });
});

describe('inbox preview (CHAT-044 / CHAT-015)', () => {
  const conversation = {
    id: 'c',
    type: 'direct' as const,
    title: null,
    lastSeq: 3,
    lastMessageAt: null,
    role: 'member' as const,
    lastReadSeq: 1,
    peer: null,
    peerLastReadSeq: 0,
    muted: false,
  };

  it('shows a missed call in the preview', () => {
    const c = {
      ...conversation,
      lastMessage: {
        type: 'call' as const,
        senderId: THEM,
        body: 'Missed video call',
        call: meta({ callerId: THEM, outcome: 'missed', endReason: 'missed', durationSec: null }),
      },
    };
    expect(previewFor(c, ME)).toBe('Missed video call');
  });

  it('prefixes your own text messages with "You:"', () => {
    const mine = {
      ...conversation,
      lastMessage: { type: 'text' as const, senderId: ME, body: 'hi' },
    };
    const theirs = {
      ...conversation,
      lastMessage: { type: 'text' as const, senderId: THEM, body: 'yo' },
    };
    expect(previewFor(mine, ME)).toBe('You: hi');
    expect(previewFor(theirs, ME)).toBe('yo');
  });

  it('is empty for a conversation with no messages', () => {
    expect(previewFor({ ...conversation, lastMessage: null }, ME)).toBe('');
  });
});
