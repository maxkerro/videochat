import { VoicePlaybackStore } from './voicePlayback';

/** Just enough of an <audio> element: plays whatever src it has unless told to fail. */
class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  playbackRate = 1;
  preload = '';
  paused = true;
  failing = new Set<string>();
  play() {
    if (this.failing.has(this.src)) {
      queueMicrotask(() => this.dispatchEvent(new Event('error')));
      return Promise.resolve();
    }
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

function setUp() {
  const audio = new FakeAudio();
  const loads: string[] = [];
  const store = new VoicePlaybackStore(
    (id, fresh) => {
      loads.push(`${id}${fresh ? ':fresh' : ''}`);
      return Promise.resolve(`https://s3.test/${id}${fresh ? '?v=2' : ''}`);
    },
    () => audio as unknown as HTMLAudioElement,
  );
  return { audio, loads, store };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('VoicePlaybackStore (CHAT-074)', () => {
  it('plays, pauses and resumes one message, loading its URL once', async () => {
    const { audio, loads, store } = setUp();
    await store.toggle('a');
    expect(store.getSnapshot()).toMatchObject({ attachmentId: 'a', playing: true });
    audio.currentTime = 3.2;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(store.getSnapshot().positionMs).toBe(3200);
    await store.toggle('a');
    expect(store.getSnapshot().playing).toBe(false);
    await store.toggle('a');
    expect(audio.currentTime).toBe(3.2);
    expect(store.getSnapshot().playing).toBe(true);
    expect(loads).toEqual(['a']);
  });

  it('starting another message stops the first; the speed carries over', async () => {
    const { audio, store } = setUp();
    await store.toggle('a');
    store.setRate(1.5);
    expect(audio.playbackRate).toBe(1.5);
    await store.toggle('b');
    expect(store.getSnapshot()).toMatchObject({ attachmentId: 'b', playing: true, rate: 1.5 });
    expect(audio.src).toContain('/b');
    expect(audio.playbackRate).toBe(1.5);
  });

  it('seeks, and starts a different message at the chosen point', async () => {
    const { audio, store } = setUp();
    await store.seek('a', 4000);
    expect(store.getSnapshot()).toMatchObject({ attachmentId: 'a', playing: true });
    expect(audio.currentTime).toBe(4);
    await store.seek('a', 1000);
    expect(audio.currentTime).toBe(1);
  });

  it('gets a fresh URL once when one fails (expired), then gives up', async () => {
    const { audio, loads, store } = setUp();
    audio.failing.add('https://s3.test/a');
    await store.toggle('a');
    await flush();
    expect(loads).toEqual(['a', 'a:fresh']);
    expect(store.getSnapshot()).toMatchObject({ playing: true, error: false });

    audio.failing.add('https://s3.test/b');
    audio.failing.add('https://s3.test/b?v=2');
    await store.toggle('b');
    await flush();
    await flush();
    expect(loads).toEqual(['a', 'a:fresh', 'b', 'b:fresh']);
    expect(store.getSnapshot()).toMatchObject({ attachmentId: 'b', playing: false, error: true });
  });

  it('rewinds at the end and stops on sign-out', async () => {
    const { audio, store } = setUp();
    await store.toggle('a');
    audio.dispatchEvent(new Event('ended'));
    expect(store.getSnapshot()).toMatchObject({ playing: false, positionMs: 0 });
    store.setRate(2);
    store.stop();
    expect(store.getSnapshot()).toMatchObject({ attachmentId: null, rate: 2 });
    expect(audio.src).toBe('');
  });
});
