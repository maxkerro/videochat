import type { INestApplication } from '@nestjs/common';
import { attachmentUploadSchema, LIMITS } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { bearer, startE2eApp, type E2eUser, type FakeS3Service } from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('attachments (CHAT-030)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let closeAll: () => Promise<void>;
  let s3: FakeS3Service;

  beforeAll(async () => {
    ({ server, signUp, close: closeAll, s3 } = await startE2eApp('att'));
  });
  afterAll(() => closeAll());

  async function directChat(a: E2eUser, b: E2eUser): Promise<string> {
    const res = await request(server())
      .post('/conversations/direct')
      .set(bearer(a.token))
      .send({ userId: b.id })
      .expect(201);
    return res.body.id as string;
  }

  async function requestUpload(
    user: E2eUser,
    conversationId: string,
    file: { filename: string; contentType: string; sizeBytes: number },
  ) {
    const res = await request(server())
      .post(`/conversations/${conversationId}/attachments`)
      .set(bearer(user.token))
      .send(file)
      .expect(201);
    return attachmentUploadSchema.parse(res.body);
  }

  /** A JPEG carrying EXIF with a GPS position, like a phone photo. */
  async function photoWithLocation(): Promise<Buffer> {
    return sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 120, b: 40 } },
    })
      .jpeg()
      .withExif({
        IFD0: { Make: 'TestPhone' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 31/1 0/1' },
      })
      .toBuffer();
  }

  it('uploads, sends and serves an image, stripped of its metadata, to members only', async () => {
    const [anna, ben, outsider] = [await signUp(), await signUp(), await signUp()];
    const conversationId = await directChat(anna, ben);
    const photo = await photoWithLocation();
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    const upload = await requestUpload(anna, conversationId, {
      filename: 'IMG_0001.jpg',
      contentType: 'image/jpeg',
      sizeBytes: photo.length,
    });
    expect(upload.uploadHeaders['Content-Type']).toBe('image/jpeg');
    s3.upload(upload.uploadUrl, photo, 'image/jpeg');

    const sent = await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), attachmentId: upload.attachmentId })
      .expect(201);
    expect(sent.body).toMatchObject({
      type: 'image',
      body: null,
      attachment: {
        id: upload.attachmentId,
        kind: 'image',
        filename: 'IMG_0001.jpg',
        width: 1200,
        height: 800,
      },
    });

    // Uploaded to a staging key; the stripped copy lives at the key downloads use.
    const key = s3.keyFromUrl(upload.uploadUrl).replace(/upload$/, 'original');
    const stored = s3.objects.get(key)!.body;
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    const thumb = s3.objects.get(key.replace(/original$/, 'thumb.webp'))!.body;
    const thumbMeta = await sharp(thumb).metadata();
    expect(Math.max(thumbMeta.width!, thumbMeta.height!)).toBe(LIMITS.attachmentThumbMaxPx);

    for (const [user, status] of [
      [ben, 200],
      [anna, 200],
      [outsider, 404],
    ] as const) {
      await request(server())
        .get(`/attachments/${upload.attachmentId}/url?variant=thumb`)
        .set(bearer(user.token))
        .expect(status);
    }

    const history = await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .expect(200);
    expect(history.body.messages.at(-1).attachment.id).toBe(upload.attachmentId);
    const list = await request(server()).get('/conversations').set(bearer(ben.token)).expect(200);
    expect(list.body[0].lastMessage).toMatchObject({
      type: 'image',
      attachment: { kind: 'image', filename: 'IMG_0001.jpg' },
    });
  });

  it('sends a file with a caption and downloads it under its own name', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const conversationId = await directChat(anna, ben);
    const pdf = Buffer.from('%PDF-1.4 fake');
    const upload = await requestUpload(anna, conversationId, {
      filename: '../../Q3 report.pdf',
      contentType: 'application/pdf',
      sizeBytes: pdf.length,
    });
    s3.upload(upload.uploadUrl, pdf, 'application/pdf');
    const clientMsgId = randomUUID();
    const sent = await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId, attachmentId: upload.attachmentId, body: 'numbers' })
      .expect(201);
    expect(sent.body).toMatchObject({
      type: 'file',
      body: 'numbers',
      attachment: { kind: 'file', filename: 'Q3 report.pdf', sizeBytes: pdf.length, width: null },
    });
    const url = await request(server())
      .get(`/attachments/${upload.attachmentId}/url`)
      .set(bearer(ben.token))
      .expect(200);
    expect(url.body.url).toContain('op=download');

    // A file has no thumbnail, and the thumbnail path never falls back to the original.
    await request(server())
      .get(`/attachments/${upload.attachmentId}/url?variant=thumb`)
      .set(bearer(ben.token))
      .expect(404);

    // A retry of the same message is fine; the same upload on another message isn't.
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId, attachmentId: upload.attachmentId, body: 'numbers' })
      .expect(201);
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), attachmentId: upload.attachmentId })
      .expect(400);

    // Re-using the still-valid upload URL after sending doesn't touch what members download.
    const storedKey = s3.keyFromUrl(upload.uploadUrl).replace(/upload$/, 'original');
    s3.upload(upload.uploadUrl, Buffer.alloc(LIMITS.attachmentMaxBytes + 1), 'text/html');
    expect(s3.objects.get(storedKey)!.body.equals(pdf)).toBe(true);
  });

  it("refuses files over the limit, uploads that never happened, and other people's uploads", async () => {
    const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
    const conversationId = await directChat(anna, ben);

    await request(server())
      .post(`/conversations/${conversationId}/attachments`)
      .set(bearer(anna.token))
      .send({
        filename: 'big.zip',
        contentType: 'application/zip',
        sizeBytes: LIMITS.attachmentMaxBytes + 1,
      })
      .expect(400);
    await request(server())
      .post(`/conversations/${conversationId}/attachments`)
      .set(bearer(clara.token))
      .send({ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 3 })
      .expect(404);

    const upload = await requestUpload(anna, conversationId, {
      filename: 'a.txt',
      contentType: 'text/plain',
      sizeBytes: 3,
    });
    // Not uploaded yet.
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), attachmentId: upload.attachmentId })
      .expect(400);
    // Lied about the size: uploaded more than the limit.
    s3.upload(upload.uploadUrl, Buffer.alloc(LIMITS.attachmentMaxBytes + 1), 'text/plain');
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), attachmentId: upload.attachmentId })
      .expect(400);
    expect(s3.objects.has(s3.keyFromUrl(upload.uploadUrl))).toBe(false);

    // Someone else can't send Anna's upload, and an unsent upload isn't viewable by others.
    const second = await requestUpload(anna, conversationId, {
      filename: 'b.txt',
      contentType: 'text/plain',
      sizeBytes: 3,
    });
    s3.upload(second.uploadUrl, Buffer.from('abc'), 'text/plain');
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .send({ clientMsgId: randomUUID(), attachmentId: second.attachmentId })
      .expect(400);
    await request(server())
      .get(`/attachments/${second.attachmentId}/url`)
      .set(bearer(ben.token))
      .expect(404);
  });

  it('rejects a message with neither text nor attachment', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const conversationId = await directChat(anna, ben);
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID() })
      .expect(400);
  });
});
