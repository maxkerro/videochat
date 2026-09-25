import { ReadReceiptThrottle } from './readReceipts';

describe('ReadReceiptThrottle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends immediately on the first request for a conversation', () => {
    const send = vi.fn();
    const throttle = new ReadReceiptThrottle(send, 1000);

    throttle.request('conv-1', 5);
    vi.advanceTimersByTime(0);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('conv-1', 5);
  });

  it('coalesces several requests inside the interval into a single trailing send', () => {
    const send = vi.fn();
    const throttle = new ReadReceiptThrottle(send, 1000);

    throttle.request('conv-1', 5);
    vi.advanceTimersByTime(0); // first send goes out immediately
    send.mockClear();

    throttle.request('conv-1', 6);
    throttle.request('conv-1', 7);
    throttle.request('conv-1', 8);
    expect(send).not.toHaveBeenCalled(); // still inside the 1s cooldown

    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('conv-1', 8); // only the highest seq, once
  });

  it('never sends a seq lower than one already sent or queued', () => {
    const send = vi.fn();
    const throttle = new ReadReceiptThrottle(send, 1000);

    throttle.request('conv-1', 10);
    vi.advanceTimersByTime(0);
    send.mockClear();

    throttle.request('conv-1', 3); // lower than what's already been sent
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
  });

  it('throttles independently per conversation', () => {
    const send = vi.fn();
    const throttle = new ReadReceiptThrottle(send, 1000);

    throttle.request('conv-1', 1);
    throttle.request('conv-2', 1);
    vi.advanceTimersByTime(0);

    expect(send).toHaveBeenCalledWith('conv-1', 1);
    expect(send).toHaveBeenCalledWith('conv-2', 1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('cancel drops a pending request without sending it', () => {
    const send = vi.fn();
    const throttle = new ReadReceiptThrottle(send, 1000);

    throttle.request('conv-1', 5);
    vi.advanceTimersByTime(0);
    send.mockClear();

    throttle.request('conv-1', 6);
    throttle.cancel('conv-1');
    vi.advanceTimersByTime(1000);

    expect(send).not.toHaveBeenCalled();
  });
});
