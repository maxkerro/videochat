import { clearDrafts, getDraft, saveDraft } from './drafts';

describe('drafts (CHAT-036)', () => {
  beforeEach(() => localStorage.clear());

  it('keeps a draft per user and conversation, and forgets an emptied one', () => {
    saveDraft('anna', 'c1', 'half a thought');
    saveDraft('anna', 'c2', 'other');
    saveDraft('ben', 'c1', 'bens');
    expect(getDraft('anna', 'c1')).toBe('half a thought');
    expect(getDraft('ben', 'c1')).toBe('bens');
    saveDraft('anna', 'c1', '   ');
    expect(getDraft('anna', 'c1')).toBe('');
    expect(getDraft('anna', 'c2')).toBe('other');
  });

  it('clears everything for a user on sign-out', () => {
    saveDraft('anna', 'c1', 'x');
    clearDrafts('anna');
    expect(getDraft('anna', 'c1')).toBe('');
  });
});
