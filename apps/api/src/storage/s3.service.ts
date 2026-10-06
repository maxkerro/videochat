import { Inject, Injectable } from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
      // Newer AWS SDKs add a CRC32 checksum to every PUT by default -- and for a *presigned* PUT
      // they compute it over an empty body at signing time, so the browser's real upload would
      // never match it. B2 (and other S3-compatibles) also handle these headers unevenly. Only
      // send checksums when an operation actually requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
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
  getSignedGetUrl(
    key: string,
    expiresInSeconds = 3600,
    /** Overrides the stored Content-Type in the response (CHAT-030: never trust the uploader's). */
    responseContentType?: string,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.env.S3_BUCKET,
      Key: key,
      ...(responseContentType ? { ResponseContentType: responseContentType } : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * CHAT-030: a signed PUT the browser uploads to directly, so file bytes never pass through the
   * API. The Content-Type is part of the signature: the upload must send exactly that header.
   */
  async getSignedPutUrl(
    key: string,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const command = new PutObjectCommand({
      Bucket: this.env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(['content-type']),
    });
    return { url, headers: { 'Content-Type': contentType } };
  }

  /** Size and type of a stored object, or null if there's nothing at that key. */
  async headObject(key: string): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }),
      );
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as Error).name === 'NotFound') return null;
      throw err;
    }
  }

  /** The object's bytes. With `maxBytes`, refuses (ObjectTooLargeError) before buffering anything
   *  larger -- the response's length is authoritative even if the object changed since a HEAD. */
  async getObject(key: string, maxBytes?: number): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }),
    );
    if (maxBytes !== undefined && (res.ContentLength ?? Infinity) > maxBytes) {
      (res.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new ObjectTooLargeError(key);
    }
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  /** Server-side copy (no bytes through the API), with a Content-Type we choose. */
  async copyObject(fromKey: string, toKey: string, contentType: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.env.S3_BUCKET,
        CopySource: `${this.env.S3_BUCKET}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
        Key: toKey,
        ContentType: contentType,
        MetadataDirective: 'REPLACE',
      }),
    );
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.env.S3_BUCKET,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }

  /** CHAT-030: signed GET that downloads under the original filename -- always as an opaque
   *  download (attachment + octet-stream), so an uploaded HTML or SVG file never renders inline
   *  on the bucket's origin. */
  getSignedDownloadUrl(key: string, filename: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: contentDisposition(filename),
      ResponseContentType: 'application/octet-stream',
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /** null when the user has no avatar; otherwise a signed URL for their 256px variant. */
  getAvatarUrl(avatarKey: string | null): Promise<string | null> {
    if (!avatarKey) return Promise.resolve(null);
    return this.getSignedGetUrl(`${avatarKey}/256.webp`);
  }
}

export class ObjectTooLargeError extends Error {
  constructor(key: string) {
    super(`Object ${key} is larger than allowed`);
    this.name = 'ObjectTooLargeError';
  }
}

/** `attachment; filename=...` with an RFC 5987 UTF-8 fallback, so non-ASCII names survive and
 *  quotes or newlines in a name can't break out of the header. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`;
}
