import { TypingThrottle } from './typingThrottle';

describe('TypingThrottle', () => {
  it('sends immediately on the first notify for a conversation (leading edge)', () => {
    const send = vi.fn();
    const throttle = new TypingThrottle(send, 3000);

    throttle.notifyTyping('conv-1');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('conv-1');
  });

  it('suppresses further notifies inside the interval', () => {
    let now = 0;
    const send = vi.fn();
    const throttle = new TypingThrottle(send, 3000, () => now);

    throttle.notifyTyping('conv-1');
    now += 1000;
    throttle.notifyTyping('conv-1');
    now += 1999;
    throttle.notifyTyping('conv-1');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends again once the interval has elapsed', () => {
    let now = 0;
    const send = vi.fn();
    const throttle = new TypingThrottle(send, 3000, () => now);

    throttle.notifyTyping('conv-1');
    now += 3000;
    throttle.notifyTyping('conv-1');

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not queue a trailing send -- a notify inside the cooldown is simply dropped', () => {
    let now = 0;
    const send = vi.fn();
    const throttle = new TypingThrottle(send, 3000, () => now);

    throttle.notifyTyping('conv-1');
    now += 500;
    throttle.notifyTyping('conv-1'); // dropped, not queued
    now += 3000; // well past the cooldown, but nothing was queued to fire on its own
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throttles independently per conversation', () => {
    const send = vi.fn();
    const throttle = new TypingThrottle(send, 3000);

    throttle.notifyTyping('conv-1');
    throttle.notifyTyping('conv-2');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('conv-1');
    expect(send).toHaveBeenCalledWith('conv-2');
  });

  it('reset drops the cooldown, so the next notify sends immediately', () => {
    let now = 0;
    const send = vi.fn();
    const throttle = new TypingThrottle(send, 3000, () => now);

    throttle.notifyTyping('conv-1');
    throttle.reset('conv-1');
    now += 10;
    throttle.notifyTyping('conv-1');

    expect(send).toHaveBeenCalledTimes(2);
  });
});
