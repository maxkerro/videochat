import { describe, expect, it } from 'vitest';
import {
  groupCallDurationText,
  groupCallParticipantsText,
  groupCallUpdatedSchema,
} from './groupCalls.js';

describe('group calls (CHAT-070)', () => {
  it('words the call length', () => {
    expect(groupCallDurationText(42)).toBe('42 s');
    expect(groupCallDurationText(754)).toBe('12:34');
    expect(groupCallDurationText(3_725)).toBe('1:02:05');
    expect(groupCallDurationText(-3)).toBe('0 s');
  });

  it('says how many are in the call', () => {
    expect(groupCallParticipantsText(0)).toBe('Starting…');
    expect(groupCallParticipantsText(1)).toBe('1 person in the call');
    expect(groupCallParticipantsText(5)).toBe('5 people in the call');
  });

  it('accepts an ended call as null', () => {
    const conversationId = '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c';
    expect(groupCallUpdatedSchema.parse({ conversationId, call: null }).call).toBeNull();
  });
});
