import { directKeyFor } from './messages.js';

describe('directKeyFor', () => {
  it('is order-independent for the same pair of users', () => {
    expect(directKeyFor('a', 'b')).toBe(directKeyFor('b', 'a'));
  });

  it('sorts the two ids into a stable "a:b" key', () => {
    expect(directKeyFor('b', 'a')).toBe('a:b');
  });

  it('rejects a user paired with themselves', () => {
    expect(() => directKeyFor('same', 'same')).toThrow(/two different users/);
  });
});
