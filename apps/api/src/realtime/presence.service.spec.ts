import { canSeePresence } from './presence.service.js';

describe('canSeePresence (CHAT-034)', () => {
  it("follows the subject's setting", () => {
    expect(canSeePresence('everyone', 'everyone', false)).toBe(true);
    expect(canSeePresence('contacts', 'everyone', true)).toBe(true);
    expect(canSeePresence('contacts', 'everyone', false)).toBe(false);
    expect(canSeePresence('nobody', 'everyone', true)).toBe(false);
  });

  it("hides everyone's presence from a viewer who hides their own", () => {
    expect(canSeePresence('everyone', 'nobody', true)).toBe(false);
    expect(canSeePresence('everyone', 'contacts', false)).toBe(true);
  });
});
