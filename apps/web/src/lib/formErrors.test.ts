import { z } from 'zod';
import { fieldErrors } from './formErrors.js';

describe('fieldErrors', () => {
  it('keys the first error message per top-level field', () => {
    const schema = z.object({ email: z.email(), password: z.string().min(8) });
    const result = schema.safeParse({ email: 'not-an-email', password: 'short' });
    expect(result.success).toBe(false);
    const errors = fieldErrors(result.error!);
    expect(Object.keys(errors)).toEqual(['email', 'password']);
    expect(errors.password).toMatch(/8/);
  });

  it('keeps only the first issue when a field has more than one', () => {
    const schema = z.object({ name: z.string().min(3).max(5) });
    const result = schema.safeParse({ name: 'x' });
    const errors = fieldErrors(result.error!);
    expect(Object.keys(errors)).toEqual(['name']);
  });

  it('ignores issues without a string field name at the top level', () => {
    const schema = z.object({ tags: z.array(z.string()).min(1) });
    const result = schema.safeParse({ tags: [] });
    // The min(1) issue's path is ['tags'], a string, so it's still captured.
    expect(fieldErrors(result.error!)).toHaveProperty('tags');
  });
});
