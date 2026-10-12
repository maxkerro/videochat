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

  it('says the server is out of date for a response of the wrong shape', () => {
    const zodError = z.object({ refreshToken: z.string() }).safeParse({}).error;
    expect(describeError(zodError)).toMatch(/may need to be updated/);
  });

  it('treats a non-JSON body (e.g. an HTML page from the wrong host) the same way', () => {
    let error: unknown;
    try {
      JSON.parse('<html>');
    } catch (e) {
      error = e;
    }
    expect(describeError(error)).toMatch(/may need to be updated/);
  });

  it('treats a failed or timed-out fetch as a connection problem', () => {
    expect(describeError(new TypeError('Network request failed'))).toMatch(
      /Can’t reach the server/,
    );
    expect(describeError(new TypeError('Network request timed out'))).toMatch(/Can’t reach/);
  });

  it('does not call a programming bug a connection problem', () => {
    expect(describeError(new TypeError('undefined is not a function'))).toBe(
      'Something went wrong: undefined is not a function',
    );
    expect(describeError('x')).toBe('Something went wrong.');
  });
});
