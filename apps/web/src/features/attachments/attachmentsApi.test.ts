import { formatBytes, uploadToStorage, UploadError } from './attachmentsApi';

class FakeXhr {
  static last: FakeXhr;
  upload: {
    onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void;
  } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  status = 0;
  headers: Record<string, string> = {};
  method = '';
  url = '';
  body: unknown;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
}

describe('formatBytes', () => {
  it('formats sizes for people', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });
});

describe('uploadToStorage', () => {
  beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXhr));
  afterEach(() => vi.unstubAllGlobals());

  it('PUTs with the signed headers and reports progress', async () => {
    const progress: number[] = [];
    const done = uploadToStorage(
      { uploadUrl: 'https://s3/put', uploadHeaders: { 'Content-Type': 'image/png' } },
      new Blob(['abc']),
      (p) => progress.push(p),
    );
    const xhr = FakeXhr.last;
    expect([xhr.method, xhr.url, xhr.headers['Content-Type']]).toEqual([
      'PUT',
      'https://s3/put',
      'image/png',
    ]);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    xhr.status = 200;
    xhr.onload?.();
    await done;
    expect(progress).toEqual([0.5, 1]);
  });

  it('fails on a storage error and can be cancelled', async () => {
    const failing = uploadToStorage(
      { uploadUrl: 'u', uploadHeaders: {} },
      new Blob(['a']),
      () => {},
    );
    FakeXhr.last.status = 403;
    FakeXhr.last.onload?.();
    await expect(failing).rejects.toThrow('Upload failed (403)');

    const controller = new AbortController();
    const cancelled = uploadToStorage(
      { uploadUrl: 'u', uploadHeaders: {} },
      new Blob(['a']),
      () => {},
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toSatisfy((e) => e instanceof UploadError && e.aborted);
  });
});
