import { describe, expect, it } from 'vitest';
import { makeEnvelope, usernameSchema, ulidSchema, wsEnvelopeSchema } from './index.js';

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
