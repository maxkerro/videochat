import { NotFoundException } from '@nestjs/common';
import { UuidParamPipe } from './uuid-param.pipe.js';

describe('UuidParamPipe', () => {
  const pipe = new UuidParamPipe();

  it('passes a well-formed UUID through unchanged', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    expect(pipe.transform(id)).toBe(id);
  });

  it('rejects a value that is not a UUID at all, with a 404 rather than letting it hit the database', () => {
    expect(() => pipe.transform('not-a-uuid')).toThrow(NotFoundException);
  });

  it('rejects a UUID-shaped string with an invalid version/variant nibble', () => {
    // Version nibble must be 1-8 and variant nibble must be 8/9/a/b per RFC 4122; '1' here fails
    // the variant check even though the shape otherwise looks right.
    expect(() => pipe.transform('11111111-1111-1111-1111-111111111111')).toThrow(NotFoundException);
  });

  it('rejects an empty string', () => {
    expect(() => pipe.transform('')).toThrow(NotFoundException);
  });
});
