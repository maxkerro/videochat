import type { CallRow } from '../db/schema.js';
import { callOutcome, callSummaryText, formatCallDuration } from './call-history.service.js';

function call(overrides: Partial<CallRow>): CallRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    conversationId: 'c',
    callerId: 'a',
    calleeId: 'b',
    media: 'video',
    status: 'ended',
    endReason: 'completed',
    callerConnectionId: 'x',
    calleeConnectionId: null,
    callerDisconnectedAt: null,
    calleeDisconnectedAt: null,
    silenced: false,
    createdAt: new Date(),
    answeredAt: new Date(),
    endedAt: new Date(),
    ...overrides,
  };
}

describe('call history wording (CHAT-044)', () => {
  it('treats every never-answered ending as missed', () => {
    for (const endReason of ['missed', 'cancelled', 'busy'] as const) {
      expect(callOutcome(call({ endReason, answeredAt: null }))).toBe('missed');
    }
  });

  it('treats an answered call that dropped as completed, but an unanswered drop as missed', () => {
    expect(callOutcome(call({ endReason: 'connection-lost' }))).toBe('completed');
    expect(callOutcome(call({ endReason: 'connection-lost', answeredAt: null }))).toBe('missed');
  });

  it('records nothing for a call that never rang anyone', () => {
    expect(callOutcome(call({ endReason: 'unavailable', answeredAt: null }))).toBeNull();
  });

  it('summarises with the duration for completed calls', () => {
    const base = { callId: 'x', callerId: 'a', endReason: 'completed' as const };
    expect(
      callSummaryText({ ...base, media: 'video', outcome: 'completed', durationSec: 754 }),
    ).toBe('Video call · 12:34');
    expect(callSummaryText({ ...base, media: 'audio', outcome: 'missed', durationSec: null })).toBe(
      'Missed audio call',
    );
    expect(
      callSummaryText({ ...base, media: 'video', outcome: 'declined', durationSec: null }),
    ).toBe('Declined video call');
  });

  it('formats long calls with hours', () => {
    expect(formatCallDuration(3_725)).toBe('1:02:05');
    expect(formatCallDuration(5)).toBe('0:05');
  });
});
