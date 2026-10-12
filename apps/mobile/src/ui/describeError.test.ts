import { ApiError } from '@videochat/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeError } from './describeError';

describe('describeError', () => {
  it('uses the API message for an API error', () => {
    expect(describeError(new ApiError(401, 'Invalid email or password'))).toBe(
      'Invalid email or password',
    );
  });

  it('says the server is out of date for an unexpected response shape', () => {
    const zodError = z.object({ refreshToken: z.string() }).safeParse({}).error;
    expect(describeError(zodError)).toMatch(/may need to be updated/);
  });

  it('treats a failed fetch (TypeError) as a connection problem', () => {
    expect(describeError(new TypeError('Network request failed'))).toMatch(
      /Can’t reach the server/,
    );
  });

  it('falls back to the error message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('x')).toBe('Something went wrong.');
  });
});
