import { describe, expect, it } from 'vitest';
import {
  makeEnvelope,
  messagesPageQuerySchema,
  usernameSchema,
  ulidSchema,
  wsEnvelopeSchema,
} from './index.js';

describe('usernameSchema', () => {
  it('accepts lowercase handles', () => {
    expect(usernameSchema.safeParse('anna_k').success).toBe(true);
  });

  it.each(['ab', 'Anna', 'anna-k', 'a'.repeat(31)])('rejects %s', (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(false);
  });
});

describe('ulidSchema', () => {
  it('accepts a valid ULID', () => {
    expect(ulidSchema.safeParse('01J9ZQ3X4K7M8N9P0QRSTVWXYZ').success).toBe(true);
  });

  it('rejects ambiguous characters', () => {
    expect(ulidSchema.safeParse('01J9ZQ3X4K7M8N9P0QRSTVWXYI').success).toBe(false);
  });
});

describe('makeEnvelope', () => {
  it('produces an envelope that passes validation', () => {
    const env = makeEnvelope('message.new', { text: 'hi' }, 'evt_1');
    expect(wsEnvelopeSchema.parse(env)).toMatchObject({ v: 1, type: 'message.new' });
  });
});

describe('messagesPageQuerySchema (CHAT-016/CHAT-017)', () => {
  it('accepts neither, just `before`, or just `after`', () => {
    expect(messagesPageQuerySchema.safeParse({}).success).toBe(true);
    expect(messagesPageQuerySchema.safeParse({ before: 5 }).success).toBe(true);
    expect(messagesPageQuerySchema.safeParse({ after: 0 }).success).toBe(true);
    expect(messagesPageQuerySchema.safeParse({ after: 5 }).success).toBe(true);
  });

  it('rejects passing both `before` and `after`', () => {
    expect(messagesPageQuerySchema.safeParse({ before: 5, after: 1 }).success).toBe(false);
  });

  it('rejects a non-positive `before` and a negative `after`', () => {
    expect(messagesPageQuerySchema.safeParse({ before: 0 }).success).toBe(false);
    expect(messagesPageQuerySchema.safeParse({ before: -1 }).success).toBe(false);
    expect(messagesPageQuerySchema.safeParse({ after: -1 }).success).toBe(false);
  });
});
