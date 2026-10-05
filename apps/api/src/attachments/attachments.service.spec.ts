import sharp from 'sharp';
import type { Database } from '../db/client.js';
import * as attachmentsDb from '../db/attachments.js';
import * as conversationsDb from '../db/conversations.js';
import type { AttachmentRow } from '../db/schema.js';
import type { S3Service } from '../storage/s3.service.js';
import {
  AttachmentsService,
  normalizeContentType,
  sanitizeFilename,
} from './attachments.service.js';

vi.mock('../db/attachments.js', () => ({
  insertAttachment: vi.fn(),
  findAttachment: vi.fn(),
  markAttachmentProcessed: vi.fn(async (_db: unknown, id: string, fields: object) => ({
    ...baseRow,
    id,
    ...fields,
    processedAt: new Date(),
  })),
  linkAttachmentToMessage: vi.fn(),
  deleteStaleUnsentAttachments: vi.fn(),
  deleteAttachments: vi.fn(),
}));
vi.mock('../db/conversations.js', () => ({ isConversationMember: vi.fn() }));

const baseRow: AttachmentRow = {
  id: '11111111-1111-4111-8111-111111111111',
  conversationId: 'conv',
  uploaderId: 'anna',
  messageId: null,
  kind: 'image',
  filename: 'cat.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 10,
  width: null,
  height: null,
  objectKey: 'attachments/conv/1/original',
  thumbKey: null,
  processedAt: null,
  createdAt: new Date(),
};

function makeS3() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    headObject: vi.fn(async (k: string) =>
      objects.has(k) ? { size: objects.get(k)!.length, contentType: null } : null,
    ),
    getObject: vi.fn(async (k: string) => objects.get(k)!),
    putObject: vi.fn(async (k: string, b: Buffer) => void objects.set(k, b)),
    deleteObjects: vi.fn(async (keys: string[]) => keys.forEach((k) => objects.delete(k))),
    getSignedPutUrl: vi.fn(async () => ({
      url: 'https://s3/put',
      headers: { 'Content-Type': 'x' },
    })),
    getSignedGetUrl: vi.fn(async (k: string) => `https://s3/get/${k}`),
    getSignedDownloadUrl: vi.fn(async (k: string) => `https://s3/dl/${k}`),
  };
}

describe('attachment helpers', () => {
  it('strips paths and control characters from filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\a\\photo.png')).toBe('photo.png');
    expect(sanitizeFilename('bad\u0000\nname.txt')).toBe('badname.txt');
    expect(sanitizeFilename('   ')).toBe('file');
  });

  it('normalises content types and falls back for junk', () => {
    expect(normalizeContentType('Image/JPEG; charset=binary')).toBe('image/jpeg');
    expect(normalizeContentType('not a type')).toBe('application/octet-stream');
  });
});

describe('AttachmentsService', () => {
  let s3: ReturnType<typeof makeS3>;
  let service: AttachmentsService;

  beforeEach(() => {
    vi.clearAllMocks();
    s3 = makeS3();
    service = new AttachmentsService({} as Database, s3 as unknown as S3Service);
  });

  it('classifies uploads: decodable image types as images, SVG and the rest as files', async () => {
    vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
    await service.createUpload('anna', 'conv', {
      filename: 'a.png',
      contentType: 'image/png',
      sizeBytes: 5,
    });
    await service.createUpload('anna', 'conv', {
      filename: 'a.svg',
      contentType: 'image/svg+xml',
      sizeBytes: 5,
    });
    const kinds = vi.mocked(attachmentsDb.insertAttachment).mock.calls.map(([, r]) => r.kind);
    expect(kinds).toEqual(['image', 'file']);
  });

  it('strips EXIF (including GPS) and makes a thumbnail before an image can be sent', async () => {
    const photo = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: '#336699' },
    })
      .jpeg()
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 31/1 0/1' } })
      .toBuffer();
    s3.objects.set(baseRow.objectKey, photo);
    vi.mocked(attachmentsDb.findAttachment).mockResolvedValue(baseRow);

    const result = await service.prepareForMessage('anna', 'conv', baseRow.id);

    expect(result).toMatchObject({ kind: 'image', width: 2000, height: 1000 });
    expect((await sharp(s3.objects.get(baseRow.objectKey)!).metadata()).exif).toBeUndefined();
    const thumb = await sharp(s3.objects.get('attachments/conv/1/thumb.webp')!).metadata();
    expect([thumb.width, thumb.height]).toEqual([512, 256]);
  });

  it('keeps an undecodable "image" as a plain file', async () => {
    s3.objects.set(baseRow.objectKey, Buffer.from('<html>not an image</html>'));
    vi.mocked(attachmentsDb.findAttachment).mockResolvedValue(baseRow);
    const result = await service.prepareForMessage('anna', 'conv', baseRow.id);
    expect(result).toMatchObject({ kind: 'file', contentType: 'application/octet-stream' });
  });

  it("refuses someone else's upload or one from another conversation", async () => {
    vi.mocked(attachmentsDb.findAttachment).mockResolvedValue(baseRow);
    await expect(service.prepareForMessage('ben', 'conv', baseRow.id)).rejects.toThrow(/not found/);
    await expect(service.prepareForMessage('anna', 'other', baseRow.id)).rejects.toThrow(
      /not found/,
    );
  });

  it("returns an already-processed upload as-is (a retried send doesn't redo the work)", async () => {
    vi.mocked(attachmentsDb.findAttachment).mockResolvedValue({
      ...baseRow,
      processedAt: new Date(),
      width: 10,
      height: 10,
    });
    await service.prepareForMessage('anna', 'conv', baseRow.id);
    expect(s3.getObject).not.toHaveBeenCalled();
  });

  it('hands signed URLs only to current members, and unsent uploads only to the uploader', async () => {
    vi.mocked(attachmentsDb.findAttachment).mockResolvedValue({ ...baseRow, messageId: null });
    vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
    await expect(service.getUrl('ben', baseRow.id, 'original')).rejects.toThrow(/not found/);
    await expect(service.getUrl('anna', baseRow.id, 'original')).resolves.toBeDefined();

    vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(false);
    vi.mocked(attachmentsDb.findAttachment).mockResolvedValue({ ...baseRow, messageId: 'm' });
    await expect(service.getUrl('clara', baseRow.id, 'thumb')).rejects.toThrow(/not found/);
  });

  it('sweeps unsent uploads and their objects', async () => {
    s3.objects.set('k1', Buffer.from('x'));
    vi.mocked(attachmentsDb.deleteStaleUnsentAttachments).mockResolvedValue([
      { ...baseRow, objectKey: 'k1' },
    ]);
    await expect(service.sweepUnsent()).resolves.toBe(1);
    expect(s3.objects.has('k1')).toBe(false);
  });
});
