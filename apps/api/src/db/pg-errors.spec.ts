import { isUniqueViolation } from './pg-errors.js';

describe('isUniqueViolation', () => {
  it('is true for a Postgres unique-violation error object', () => {
    expect(isUniqueViolation({ code: '23505', message: 'duplicate key' })).toBe(true);
  });

  it('is false for other Postgres error codes', () => {
    expect(isUniqueViolation({ code: '23503', message: 'foreign key violation' })).toBe(false);
  });

  it('is false for a plain Error with no code', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });

  it('is false for non-object values', () => {
    expect(isUniqueViolation('boom')).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
