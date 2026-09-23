import sharp from 'sharp';
import { BadRequestException } from '@nestjs/common';
import { AvatarService } from './avatar.service.js';

function makeService() {
  const s3 = { putObject: vi.fn().mockResolvedValue(undefined) };
  const service = new AvatarService(s3 as never);
  return { service, s3 };
}

describe('AvatarService', () => {
  it('rejects a disallowed mimetype', async () => {
    const { service } = makeService();
    await expect(
      service.uploadAvatar('user-1', {
        buffer: Buffer.from('whatever'),
        mimetype: 'application/pdf',
        size: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a file over the size limit', async () => {
    const { service } = makeService();
    await expect(
      service.uploadAvatar('user-1', {
        buffer: Buffer.from('whatever'),
        mimetype: 'image/png',
        size: 100 * 1024 * 1024,
      }),
    ).rejects.toThrow(/must be under/);
  });

  it('rejects non-image bytes that merely claim an image mimetype', async () => {
    const { service } = makeService();
    await expect(
      service.uploadAvatar('user-1', {
        buffer: Buffer.from('this is not actually an image'),
        mimetype: 'image/png',
        size: 30,
      }),
    ).rejects.toThrow(/Could not read this file as an image/);
  });

  it('accepts a real image, uploads both size variants, and returns the storage key', async () => {
    const { service, s3 } = makeService();
    const pngBuffer = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const key = await service.uploadAvatar('user-1', {
      buffer: pngBuffer,
      mimetype: 'image/png',
      size: pngBuffer.length,
    });

    expect(key).toBe('avatars/user-1');
    expect(s3.putObject).toHaveBeenCalledWith(
      'avatars/user-1/64.webp',
      expect.any(Buffer),
      'image/webp',
    );
    expect(s3.putObject).toHaveBeenCalledWith(
      'avatars/user-1/256.webp',
      expect.any(Buffer),
      'image/webp',
    );
  });
});
