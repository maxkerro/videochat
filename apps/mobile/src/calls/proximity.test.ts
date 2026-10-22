import { describe, expect, it, vi } from 'vitest';
import type { AudioSnapshot } from './audioRoute';
import { ProximityGuard, wantsProximityScreenOff } from './proximity';

const audio = (over: Partial<AudioSnapshot> = {}): AudioSnapshot => ({
  route: 'earpiece',
  choices: ['earpiece', 'speaker'],
  active: true,
  media: 'audio',
  ...over,
});

describe('proximity screen-off (CHAT-083)', () => {
  it('only for a live audio call on the earpiece', () => {
    expect(wantsProximityScreenOff(audio())).toBe(true);
    expect(wantsProximityScreenOff(audio({ route: 'speaker' }))).toBe(false);
    expect(wantsProximityScreenOff(audio({ route: 'headset' }))).toBe(false);
    expect(wantsProximityScreenOff(audio({ route: 'bluetooth' }))).toBe(false);
    expect(wantsProximityScreenOff(audio({ route: null }))).toBe(false);
    expect(wantsProximityScreenOff(audio({ media: 'video' }))).toBe(false);
    expect(wantsProximityScreenOff(audio({ active: false }))).toBe(false);
  });

  it('takes the lock and lets it go as the route changes and the call ends', () => {
    const setEnabled = vi.fn();
    const guard = new ProximityGuard({ setEnabled });
    guard.sync(audio({ route: null })); // connecting: route not known yet
    expect(setEnabled).not.toHaveBeenCalled();
    guard.sync(audio());
    guard.sync(audio()); // no repeats
    expect(setEnabled.mock.calls).toEqual([[true]]);
    guard.sync(audio({ route: 'speaker' }));
    guard.sync(audio({ route: 'earpiece' }));
    guard.sync(audio({ route: 'bluetooth' }));
    guard.sync(audio({ route: 'earpiece' }));
    guard.sync(audio({ media: 'video' })); // video turned on
    guard.sync(audio({ media: 'audio' }));
    guard.sync(audio({ active: false })); // call ended
    expect(setEnabled.mock.calls.map((c) => c[0])).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    guard.release(); // nothing held: nothing to do
    expect(setEnabled).toHaveBeenCalledTimes(8);
  });

  it('releases when the call screen goes away while held', () => {
    const setEnabled = vi.fn();
    const guard = new ProximityGuard({ setEnabled });
    guard.sync(audio());
    guard.release();
    expect(setEnabled.mock.calls).toEqual([[true], [false]]);
  });
});
