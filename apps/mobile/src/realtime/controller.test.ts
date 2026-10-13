import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_GRACE_MS, createRealtimeController } from './controller';

function setup() {
  const calls: string[] = [];
  const onResume = vi.fn();
  const controller = createRealtimeController({
    target: { connect: () => calls.push('connect'), close: () => calls.push('close') },
    onResume,
  });
  return { controller, calls, onResume };
}

describe('createRealtimeController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connects when signed in, online and in the foreground', () => {
    const { controller, calls } = setup();
    expect(calls).toEqual([]);
    controller.setSignedIn(true);
    expect(calls).toEqual(['connect']);
  });

  it('keeps the socket for 30 s in the background, then closes it', () => {
    const { controller, calls } = setup();
    controller.setSignedIn(true);
    controller.setActive(false);
    vi.advanceTimersByTime(BACKGROUND_GRACE_MS - 1);
    expect(calls).toEqual(['connect']);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['connect', 'close']);
  });

  it('a quick trip to the background does not drop the socket, but still catches up', () => {
    const { controller, calls, onResume } = setup();
    controller.setSignedIn(true);
    controller.setActive(false);
    vi.advanceTimersByTime(10_000);
    controller.setActive(true);
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(['connect']);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('reconnects on return after the socket was closed in the background', () => {
    const { controller, calls, onResume } = setup();
    controller.setSignedIn(true);
    controller.setActive(false);
    vi.advanceTimersByTime(BACKGROUND_GRACE_MS);
    controller.setActive(true);
    expect(calls).toEqual(['connect', 'close', 'connect']);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('airplane mode closes the socket at once and coming back reconnects', () => {
    const { controller, calls } = setup();
    controller.setSignedIn(true);
    controller.setOnline(false);
    controller.setOnline(true);
    expect(calls).toEqual(['connect', 'close', 'connect']);
  });

  it('does not connect while offline or signed out, and signing out closes it', () => {
    const { controller, calls } = setup();
    controller.setOnline(false);
    controller.setSignedIn(true);
    expect(calls).toEqual([]);
    controller.setOnline(true);
    controller.setSignedIn(false);
    expect(calls).toEqual(['connect', 'close']);
  });

  it('a background trip restarts the 30 s clock each time', () => {
    const { controller, calls } = setup();
    controller.setSignedIn(true);
    controller.setActive(false);
    vi.advanceTimersByTime(20_000);
    controller.setActive(true);
    controller.setActive(false);
    vi.advanceTimersByTime(20_000);
    expect(calls).toEqual(['connect']);
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual(['connect', 'close']);
  });

  it('dispose closes the socket and cancels the timer', () => {
    const { controller, calls } = setup();
    controller.setSignedIn(true);
    controller.setActive(false);
    controller.dispose();
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(['connect', 'close']);
  });
});
