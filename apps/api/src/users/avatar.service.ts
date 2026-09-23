import { BadRequestException, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { LIMITS } from '@videochat/shared';
import { S3Service } from '../storage/s3.service.js';

const SIZES = [64, 256] as const;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface UploadedAvatarFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

@Injectable()
export class AvatarService {
  constructor(private readonly s3: S3Service) {}

  /** Resizes to every size in SIZES and uploads each; returns the storage key to save on the user. */
  async uploadAvatar(userId: string, file: UploadedAvatarFile): Promise<string> {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Avatar must be a JPEG, PNG or WebP image');
    }
    if (file.size > LIMITS.avatarMaxBytes) {
      throw new BadRequestException(
        `Avatar must be under ${Math.floor(LIMITS.avatarMaxBytes / (1024 * 1024))} MB`,
      );
    }

    const key = `avatars/${userId}`;
    // Re-encoding through sharp both produces the resized variants and validates the file is
    // actually decodable image data -- sharp rejects a file that merely claims an image mimetype
    // but isn't one, which the mimetype check above can't catch on its own.
    await Promise.all(
      SIZES.map(async (size) => {
        let resized: Buffer;
        try {
          resized = await sharp(file.buffer)
            .resize(size, size, { fit: 'cover' })
            .webp({ quality: 85 })
            .toBuffer();
        } catch {
          throw new BadRequestException('Could not read this file as an image');
        }
        await this.s3.putObject(`${key}/${size}.webp`, resized, 'image/webp');
      }),
    );
    return key;
  }
}
