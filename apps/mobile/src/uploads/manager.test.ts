import type { AttachmentUpload, Message } from '@videochat/shared';
import { describe, expect, it, vi } from 'vitest';
import { UploadError } from '../lib/errors';
import type { PickedFile, UploadDeps } from './flow';
import { createUploadManager } from './manager';

const file: PickedFile = {
  uri: 'file:///p.jpg',
  name: 'p.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 10,
};
const slot: AttachmentUpload = {
  attachmentId: '00000000-0000-4000-8000-000000000001',
  uploadUrl: 'https://storage/u',
  uploadHeaders: {},
  expiresAt: new Date(0).toISOString(),
};
const message = { id: 'm1', conversationId: 'c1' } as unknown as Message;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(over: Partial<UploadDeps<string>> = {}) {
  let n = 0;
  const deps: UploadDeps<string> = {
    prepare: async () => ({ blob: 'b', name: 'p.jpg', contentType: 'image/jpeg', sizeBytes: 5 }),
    requestUpload: async () => slot,
    upload: async (_s, _b, onProgress) => onProgress(0.5),
    send: async () => message,
    sleep: async () => undefined,
    ...over,
  };
  const record = vi.fn(async () => undefined);
  let generation = 1;
  const manager = createUploadManager<string>({
    deps,
    newId: () => `id${++n}`,
    generation: () => generation,
    record,
    describeError: (e) => (e as Error).message,
  });
  return { manager, record, bump: () => (generation += 1) };
}

describe('upload manager', () => {
  it('shows an entry while uploading, then removes it and records the message', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { manager, record } = setup({ send: async () => (await gate, message) });
    manager.start('c1', file);
    expect(manager.getSnapshot()).toHaveLength(1);
    expect(manager.getSnapshot()[0]).toMatchObject({ conversationId: 'c1', status: 'uploading' });
    await tick();
    expect(manager.getSnapshot()[0]!.phase).toBe('sending');
    release();
    await tick();
    expect(manager.getSnapshot()).toHaveLength(0);
    expect(record).toHaveBeenCalledWith(message, 1);
  });

  it('drops the bubble only after the sent message is recorded (no gap in the list)', async () => {
    let finishRecording!: () => void;
    const { manager, record } = setup();
    record.mockImplementation(
      () => new Promise<undefined>((r) => (finishRecording = () => r(undefined))),
    );
    manager.start('c1', file);
    await tick();
    await tick();
    expect(record).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).toHaveLength(1); // still shown while the message is being added
    finishRecording();
    await tick();
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  it('keeps going with no screen subscribed (leaving the chat does not cancel)', async () => {
    const { manager, record } = setup();
    const unsubscribe = manager.subscribe(() => undefined);
    manager.start('c1', file);
    unsubscribe();
    await tick();
    await tick();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('marks a failure and retries from where it stopped on request', async () => {
    const upload = vi.fn<UploadDeps<string>['upload']>(async () => undefined);
    const send = vi
      .fn<UploadDeps<string>['send']>()
      .mockRejectedValueOnce(new UploadError('The server said no'))
      .mockResolvedValue(message);
    const { manager, record } = setup({ upload, send });
    const id = manager.start('c1', file);
    await tick();
    await tick();
    expect(manager.getSnapshot()[0]).toMatchObject({
      status: 'failed',
      error: 'The server said no',
    });
    manager.retry(id);
    await tick();
    await tick();
    expect(manager.getSnapshot()).toHaveLength(0);
    expect(upload).toHaveBeenCalledTimes(1); // not uploaded twice
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('discard cancels an upload in flight and nothing is sent', async () => {
    let seenSignal: AbortSignal | undefined;
    const send = vi.fn<UploadDeps<string>['send']>(async () => message);
    const { manager, record } = setup({
      upload: (_s, _b, _p, signal) =>
        new Promise((_resolve, reject) => {
          seenSignal = signal;
          signal?.addEventListener('abort', () => reject(new UploadError('Upload cancelled')));
        }),
      send,
    });
    const id = manager.start('c1', file);
    await tick();
    manager.discard(id);
    await tick();
    expect(seenSignal?.aborted).toBe(true);
    expect(manager.getSnapshot()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('clear (sign-out) cancels everything, so the next account never sends it', async () => {
    const send = vi.fn<UploadDeps<string>['send']>(async () => message);
    const { manager } = setup({
      upload: (_s, _b, _p, signal) =>
        new Promise((resolve) => signal?.addEventListener('abort', () => resolve())),
      send,
    });
    manager.start('c1', file);
    manager.start('c2', file);
    await tick();
    manager.clear();
    await tick();
    expect(manager.getSnapshot()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled(); // upload "finished" after abort, but the send is skipped
  });

  it('records with the generation the upload started under', async () => {
    const { manager, record, bump } = setup();
    manager.start('c1', file);
    bump(); // the account changed while it was in flight
    await tick();
    await tick();
    expect(record).toHaveBeenCalledWith(message, 1);
  });
});
