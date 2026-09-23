import { Inject, Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.js';
import { ENV } from '../infra/tokens.js';

/** S3-compatible object storage: MinIO locally (see docker-compose.yml), S3/R2 in the cloud. */
@Injectable()
export class S3Service {
  private readonly client: S3Client;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Short-lived signed GET URL. Only conversation/profile owners' clients ever see one, and it
   *  is meant to be regenerated on every read (e.g. every `/me`), not cached long-term. */
  getSignedGetUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /** null when the user has no avatar; otherwise a signed URL for their 256px variant. */
  getAvatarUrl(avatarKey: string | null): Promise<string | null> {
    if (!avatarKey) return Promise.resolve(null);
    return this.getSignedGetUrl(`${avatarKey}/256.webp`);
  }
}
