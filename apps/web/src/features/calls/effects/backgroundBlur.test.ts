import { canBlurBackground, SLOW_FRAME_MS, SLOW_SECONDS, SlowBlurDetector } from './backgroundBlur';

describe('background blur (CHAT-075)', () => {
  it('turns itself off only after several slow seconds in a row, once', () => {
    const onSlow = vi.fn();
    const d = new SlowBlurDetector(onSlow);
    for (let i = 0; i < SLOW_SECONDS - 1; i++) d.report({ frameMs: SLOW_FRAME_MS + 10 });
    d.report({ frameMs: 5 }); // a fast second resets the count
    for (let i = 0; i < SLOW_SECONDS - 1; i++) d.report({ frameMs: SLOW_FRAME_MS + 10 });
    expect(onSlow).not.toHaveBeenCalled();
    d.report({ frameMs: SLOW_FRAME_MS + 10 });
    expect(onSlow).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) d.report({ frameMs: 500 });
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it('is not offered where the browser lacks WebGL2/VideoFrame (jsdom)', () => {
    expect(canBlurBackground()).toBe(false);
  });
});
