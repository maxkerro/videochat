import { canSeePresence } from './presence.service.js';

describe('canSeePresence (CHAT-034)', () => {
  it("follows the subject's setting", () => {
    expect(canSeePresence('everyone', 'everyone', false)).toBe(true);
    expect(canSeePresence('contacts', 'everyone', true)).toBe(true);
    expect(canSeePresence('contacts', 'everyone', false)).toBe(false);
    expect(canSeePresence('nobody', 'everyone', true)).toBe(false);
  });

  it('is reciprocal: a viewer sees only those they would share their own presence with', () => {
    expect(canSeePresence('everyone', 'nobody', true)).toBe(false);
    expect(canSeePresence('everyone', 'contacts', true)).toBe(true);
    expect(canSeePresence('everyone', 'contacts', false)).toBe(false);
  });
});
