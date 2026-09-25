import { getLastSeenSeq, recordSeenSeq, trackedConversationIds } from './lastSeenSeq';

describe('lastSeenSeq', () => {
  it('has no bookmark for a conversation never recorded', () => {
    expect(getLastSeenSeq('conv-1')).toBeNull();
  });

  it('records and reads back a seq', () => {
    recordSeenSeq('conv-1', 5);
    expect(getLastSeenSeq('conv-1')).toBe(5);
  });

  it('is monotonic -- a lower or equal seq never moves the bookmark backwards', () => {
    recordSeenSeq('conv-1', 10);
    recordSeenSeq('conv-1', 3);
    expect(getLastSeenSeq('conv-1')).toBe(10);
    recordSeenSeq('conv-1', 10);
    expect(getLastSeenSeq('conv-1')).toBe(10);
  });

  it('advances on a genuinely higher seq', () => {
    recordSeenSeq('conv-1', 10);
    recordSeenSeq('conv-1', 11);
    expect(getLastSeenSeq('conv-1')).toBe(11);
  });

  it('tracks each conversation independently', () => {
    recordSeenSeq('conv-1', 5);
    recordSeenSeq('conv-2', 9);
    expect(getLastSeenSeq('conv-1')).toBe(5);
    expect(getLastSeenSeq('conv-2')).toBe(9);
  });

  it('adds a conversation to the tracked index exactly once, the first time it is seen', () => {
    expect(trackedConversationIds()).toEqual([]);
    recordSeenSeq('conv-1', 1);
    recordSeenSeq('conv-1', 2);
    recordSeenSeq('conv-2', 1);
    expect(trackedConversationIds().sort()).toEqual(['conv-1', 'conv-2']);
  });
});
