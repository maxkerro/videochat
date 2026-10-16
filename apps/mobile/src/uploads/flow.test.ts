import type { AttachmentUpload, Message } from '@videochat/shared';
import { ApiError, LIMITS } from '@videochat/shared';
import { describe, expect, it, vi } from 'vitest';
import { UploadError } from '../lib/errors';
import {
  isRetryable,
  newUploadProgress,
  runUpload,
  type PickedFile,
  type UploadDeps,
  type UploadHooks,
  type UploadJob,
} from './flow';

const file: PickedFile = {
  uri: 'file:///p.jpg',
  name: 'p.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 10,
};
const job: UploadJob = {
  id: 'u1',
  conversationId: 'c1',
  file,
  replyToId: null,
  clientMsgId: 'client-1',
};
const slot = (n: number): AttachmentUpload => ({
  attachmentId: `00000000-0000-4000-8000-00000000000${n}`,
  uploadUrl: `https://storage/upload${n}`,
  uploadHeaders: { 'Content-Type': 'image/jpeg' },
  expiresAt: new Date(0).toISOString(),
});
const message = { id: 'm1' } as unknown as Message;

function makeDeps(over: Partial<UploadDeps<string>> = {}) {
  let n = 0;
  const deps: UploadDeps<string> = {
    prepare: vi.fn(async () => ({
      blob: 'bytes',
      name: 'p.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 500,
    })),
    requestUpload: vi.fn(async () => slot(++n)),
    upload: vi.fn(async (_s, _b, onProgress) => onProgress(1)),
    send: vi.fn(async () => message),
    sleep: vi.fn(async () => undefined),
    ...over,
  };
  return deps;
}
const hooks = (): UploadHooks & { phases: string[] } => {
  const phases: string[] = [];
  return { phases, onPhase: (p) => phases.push(p), onProgress: vi.fn(), onRetry: vi.fn() };
};

describe('runUpload', () => {
  it('prepares, requests a slot, uploads, then sends with the same client id', async () => {
    const deps = makeDeps();
    const h = hooks();
    await expect(runUpload(job, deps, newUploadProgress(), h)).resolves.toBe(message);
    expect(h.phases).toEqual(['preparing', 'uploading', 'sending']);
    expect(deps.requestUpload).toHaveBeenCalledWith('c1', {
      filename: 'p.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 500,
    });
    expect(deps.send).toHaveBeenCalledWith('c1', {
      clientMsgId: 'client-1',
      attachmentId: slot(1).attachmentId,
    });
  });

  it('CHAT-074: sends a voice recording with its length and waveform', async () => {
    const voice = { durationMs: 4200, waveform: [5, 80, 100] };
    const deps = makeDeps({
      prepare: vi.fn(async () => ({
        blob: 'm4a',
        name: 'Voice message.m4a',
        contentType: 'audio/mp4',
        sizeBytes: 900,
      })),
    });
    const voiceJob: UploadJob = {
      ...job,
      file: {
        uri: 'file:///v.m4a',
        name: 'Voice message.m4a',
        contentType: 'audio/mp4',
        sizeBytes: null,
        voice,
      },
    };
    await runUpload(voiceJob, deps, newUploadProgress(), hooks());
    expect(deps.requestUpload).toHaveBeenCalledWith('c1', {
      filename: 'Voice message.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 900,
      voice,
    });
  });

  it('includes the reply target', async () => {
    const deps = makeDeps();
    await runUpload({ ...job, replyToId: 'm0' }, deps, newUploadProgress(), hooks());
    expect(vi.mocked(deps.send).mock.calls[0]![1]).toMatchObject({ replyToId: 'm0' });
  });

  it('retries a dropped connection with a fresh slot and gives up after three tries', async () => {
    const deps = makeDeps({
      upload: vi.fn(async () => {
        throw new UploadError('Upload failed -- check your connection', true);
      }),
    });
    const h = hooks();
    await expect(runUpload(job, deps, newUploadProgress(), h)).rejects.toThrow(/connection/);
    expect(deps.upload).toHaveBeenCalledTimes(3);
    expect(deps.requestUpload).toHaveBeenCalledTimes(3); // a new link each time
    expect(deps.prepare).toHaveBeenCalledTimes(1); // the file is read only once
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(h.onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry a file the server will refuse', async () => {
    const deps = makeDeps({
      upload: vi.fn(async () => {
        throw new UploadError('Upload failed (400)', false);
      }),
    });
    await expect(runUpload(job, deps, newUploadProgress(), hooks())).rejects.toThrow('400');
    expect(deps.upload).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty or oversized file before asking for a slot', async () => {
    const big = makeDeps({
      prepare: vi.fn(async () => ({
        blob: 'x',
        name: 'a',
        contentType: 'application/pdf',
        sizeBytes: LIMITS.attachmentMaxBytes + 1,
      })),
    });
    await expect(runUpload(job, big, newUploadProgress(), hooks())).rejects.toThrow(/up to/);
    expect(big.requestUpload).not.toHaveBeenCalled();
    const empty = makeDeps({
      prepare: vi.fn(async () => ({
        blob: '',
        name: 'a',
        contentType: 'application/pdf',
        sizeBytes: 0,
      })),
    });
    await expect(runUpload(job, empty, newUploadProgress(), hooks())).rejects.toThrow(/empty/);
  });

  it('resumes at the send step after the send failed: no second upload, same client id', async () => {
    const send = vi
      .fn<UploadDeps<string>['send']>()
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockResolvedValue(message);
    const deps = makeDeps({ send });
    await runUpload(job, deps, newUploadProgress(), hooks());
    expect(deps.upload).toHaveBeenCalledTimes(1);
    expect(deps.requestUpload).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1].clientMsgId).toBe('client-1');
  });

  it('a manual retry keeps what the failed run finished', async () => {
    const progress = newUploadProgress<string>();
    const failing = makeDeps({
      send: vi.fn(async () => {
        throw new ApiError(400, 'nope');
      }),
    });
    await expect(runUpload(job, failing, progress, hooks())).rejects.toThrow('nope');
    const ok = makeDeps();
    await runUpload(job, ok, progress, hooks());
    expect(ok.prepare).not.toHaveBeenCalled();
    expect(ok.upload).not.toHaveBeenCalled();
    expect(ok.send).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once cancelled', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      upload: vi.fn(async () => {
        controller.abort();
        throw new UploadError('Upload failed -- check your connection', true);
      }),
    });
    await expect(
      runUpload(job, deps, newUploadProgress(), { ...hooks(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(deps.upload).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation', () => {
  it('never asks for a slot when cancelled while the photo was being prepared', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      prepare: vi.fn(async () => {
        controller.abort(); // sign-out while the photo is shrunk
        return { blob: 'b', name: 'p.jpg', contentType: 'image/jpeg', sizeBytes: 5 };
      }),
    });
    await expect(
      runUpload(job, deps, newUploadProgress(), { ...hooks(), signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    expect(deps.requestUpload).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('does not call the API after a retry pause during which it was cancelled', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      upload: vi.fn(async () => {
        throw new UploadError('Upload failed -- check your connection', true);
      }),
      sleep: vi.fn(async () => controller.abort()), // sign-out during the pause
    });
    await expect(
      runUpload(job, deps, newUploadProgress(), { ...hooks(), signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    expect(deps.requestUpload).toHaveBeenCalledTimes(1); // not again after the pause
    expect(deps.upload).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryable', () => {
  it('classifies failures', () => {
    expect(isRetryable(new UploadError('x', true))).toBe(true);
    expect(isRetryable(new UploadError('x'))).toBe(false);
    expect(isRetryable(new ApiError(500, 'x'))).toBe(true);
    expect(isRetryable(new ApiError(429, 'x'))).toBe(true);
    expect(isRetryable(new ApiError(403, 'x'))).toBe(false);
    expect(isRetryable(new TypeError('Network request failed'))).toBe(true);
    expect(isRetryable(new Error('boom'))).toBe(false);
  });
});
