import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  ATTACHMENT_IMAGE_TYPES,
  LIMITS,
  type Attachment,
  type AttachmentUpload,
  type AttachmentUrl,
  type CreateAttachmentUploadInput,
} from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  deleteAttachments,
  deleteStaleUnsentAttachments,
  findAttachment,
  insertAttachment,
  linkAttachmentToMessage,
  markAttachmentProcessed,
} from '../db/attachments.js';
import type { Database } from '../db/client.js';
import { isConversationMember } from '../db/conversations.js';
import type { AttachmentRow } from '../db/schema.js';
import { DB } from '../infra/tokens.js';
import { S3Service } from '../storage/s3.service.js';

/** How long a signed upload URL stays valid. */
const UPLOAD_URL_TTL_SEC = 15 * 60;
/** How long a signed download/view URL stays valid. Short: it's re-fetched on demand. */
export const DOWNLOAD_URL_TTL_SEC = 10 * 60;
/** Uploads never attached to a message are removed after this long. */
const UNSENT_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const IMAGE_TYPES = new Set<string>(ATTACHMENT_IMAGE_TYPES);

/** Strips anything path-like or invisible from a client-supplied filename. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'file').slice(0, 255);
}

/** Lowercased MIME type without parameters, or a generic binary type if it doesn't look like one. */
export function normalizeContentType(type: string): string {
  const t = type.split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) ? t : 'application/octet-stream';
}

export function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
  };
}

/**
 * CHAT-030: file and image attachments.
 *
 * 1. `createUpload` -- a member asks to upload; gets a short-lived signed PUT straight to object
 *    storage (the bytes never pass through the API).
 * 2. The client uploads, then sends a message with `attachmentId`; MessagesService calls
 *    `prepareForMessage`, which checks the upload really happened and is within the size limit,
 *    and for images strips metadata (EXIF location!) and makes a thumbnail -- before anyone else
 *    can download it.
 * 3. `getUrl` hands out short-lived signed GETs, re-checking membership every time.
 *
 * Image processing runs inside the send request rather than a background queue: a 25 MB image
 * takes well under a second, and doing it before the message exists means no unstripped original
 * is ever downloadable. Worth moving to a worker if sends ever get slow.
 */
@Injectable()
export class AttachmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentsService.name);
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly s3: S3Service,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => void this.sweepUnsent(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  async createUpload(
    userId: string,
    conversationId: string,
    input: CreateAttachmentUploadInput,
  ): Promise<AttachmentUpload> {
    await this.requireMember(conversationId, userId);
    const id = randomUUID();
    const contentType = normalizeContentType(input.contentType);
    const objectKey = `attachments/${conversationId}/${id}/original`;
    await insertAttachment(this.db, {
      id,
      conversationId,
      uploaderId: userId,
      kind: IMAGE_TYPES.has(contentType) ? 'image' : 'file',
      filename: sanitizeFilename(input.filename),
      contentType,
      sizeBytes: input.sizeBytes,
      objectKey,
    });
    const { url, headers } = await this.s3.getSignedPutUrl(
      objectKey,
      contentType,
      UPLOAD_URL_TTL_SEC,
    );
    return {
      attachmentId: id,
      uploadUrl: url,
      uploadHeaders: headers,
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString(),
    };
  }

  /**
   * Verifies an upload before a message may carry it, and processes it once. Only the uploader
   * can attach it, only in the conversation it was uploaded to. A retried send (same attachment,
   * already processed) returns the stored result without redoing the work.
   */
  async prepareForMessage(
    userId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<Attachment> {
    const row = await findAttachment(this.db, attachmentId);
    if (!row || row.uploaderId !== userId || row.conversationId !== conversationId) {
      throw new BadRequestException('Attachment not found');
    }
    if (row.processedAt) return toAttachment(row);

    const head = await this.s3.headObject(row.objectKey);
    if (!head) throw new BadRequestException('The file has not finished uploading');
    if (head.size <= 0 || head.size > LIMITS.attachmentMaxBytes) {
      await this.discard(row);
      throw new BadRequestException(
        `Files can be up to ${LIMITS.attachmentMaxBytes / (1024 * 1024)} MB`,
      );
    }

    if (row.kind === 'image') {
      return toAttachment(await this.processImage(row));
    }
    return toAttachment(
      await markAttachmentProcessed(this.db, row.id, {
        sizeBytes: head.size,
        width: null,
        height: null,
        thumbKey: null,
        contentType: row.contentType,
      }),
    );
  }

  async linkToMessage(attachmentId: string, messageId: string): Promise<void> {
    await linkAttachmentToMessage(this.db, attachmentId, messageId);
  }

  async getUrl(
    userId: string,
    attachmentId: string,
    variant: 'original' | 'thumb',
  ): Promise<AttachmentUrl> {
    const row = await findAttachment(this.db, attachmentId);
    // 404 for everything a non-member shouldn't learn about, including "exists but unsent".
    if (
      !row ||
      !(await isConversationMember(this.db, row.conversationId, userId)) ||
      (row.messageId === null && row.uploaderId !== userId)
    ) {
      throw new NotFoundException('Attachment not found');
    }
    const key = variant === 'thumb' && row.thumbKey ? row.thumbKey : row.objectKey;
    const url =
      variant === 'original' && row.kind === 'file'
        ? await this.s3.getSignedDownloadUrl(key, row.filename, DOWNLOAD_URL_TTL_SEC)
        : await this.s3.getSignedGetUrl(key, DOWNLOAD_URL_TTL_SEC);
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SEC * 1000).toISOString() };
  }

  /** Removes attachments and their stored objects (CHAT-032 deletes call this too). */
  async deleteRows(rows: AttachmentRow[]): Promise<void> {
    if (!rows.length) return;
    await this.s3.deleteObjects(
      rows.flatMap((r) => [r.objectKey, ...(r.thumbKey ? [r.thumbKey] : [])]),
    );
    await deleteAttachments(
      this.db,
      rows.map((r) => r.id),
    );
  }

  /** Removes stored files for attachment rows already deleted from the database. */
  async deleteFiles(rows: AttachmentRow[]): Promise<void> {
    if (!rows.length) return;
    await this.s3
      .deleteObjects(rows.flatMap((r) => [r.objectKey, ...(r.thumbKey ? [r.thumbKey] : [])]))
      .catch((err: Error) => this.logger.warn(`Couldn't delete attachment files: ${err.message}`));
  }

  async sweepUnsent(now = new Date()): Promise<number> {
    try {
      const stale = await deleteStaleUnsentAttachments(
        this.db,
        new Date(now.getTime() - UNSENT_TTL_MS),
      );
      if (stale.length) {
        await this.s3.deleteObjects(
          stale.flatMap((r) => [r.objectKey, ...(r.thumbKey ? [r.thumbKey] : [])]),
        );
      }
      return stale.length;
    } catch (err) {
      this.logger.warn(`Unsent-attachment sweep failed: ${(err as Error).message}`);
      return 0;
    }
  }

  private async processImage(row: AttachmentRow): Promise<AttachmentRow> {
    const original = await this.s3.getObject(row.objectKey);
    const animated = row.contentType === 'image/gif';
    let cleaned: Buffer;
    let width: number | undefined;
    let height: number | undefined;
    let thumb: Buffer;
    try {
      // rotate() applies the EXIF orientation to the pixels; sharp drops all metadata (EXIF, GPS,
      // XMP) on output unless asked to keep it. Re-encoding in the original format keeps the
      // file what the sender sent, minus the metadata.
      const pipeline = sharp(original, { animated, limitInputPixels: 100_000_000 }).rotate();
      const encoded =
        row.contentType === 'image/png'
          ? pipeline.png()
          : row.contentType === 'image/webp'
            ? pipeline.webp({ quality: 90 })
            : animated
              ? pipeline.gif()
              : pipeline.jpeg({ quality: 90, mozjpeg: true });
      const out = await encoded.toBuffer({ resolveWithObject: true });
      cleaned = out.data;
      width = out.info.width;
      height = out.info.pageHeight ?? out.info.height;
      thumb = await sharp(cleaned, { animated: false })
        .resize(LIMITS.attachmentThumbMaxPx, LIMITS.attachmentThumbMaxPx, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      // Claimed to be an image but isn't decodable: keep it, as a plain file nobody's browser
      // will try to render inline.
      return markAttachmentProcessed(this.db, row.id, {
        kind: 'file',
        sizeBytes: original.length,
        width: null,
        height: null,
        thumbKey: null,
        contentType: 'application/octet-stream',
      });
    }
    const thumbKey = row.objectKey.replace(/\/original$/, '/thumb.webp');
    await this.s3.putObject(row.objectKey, cleaned, row.contentType);
    await this.s3.putObject(thumbKey, thumb, 'image/webp');
    return markAttachmentProcessed(this.db, row.id, {
      sizeBytes: cleaned.length,
      width: width ?? null,
      height: height ?? null,
      thumbKey,
      contentType: row.contentType,
    });
  }

  private async discard(row: AttachmentRow): Promise<void> {
    await this.deleteRows([row]).catch(() => undefined);
  }

  private async requireMember(conversationId: string, userId: string): Promise<void> {
    if (!(await isConversationMember(this.db, conversationId, userId))) {
      throw new NotFoundException('Conversation not found');
    }
  }
}
