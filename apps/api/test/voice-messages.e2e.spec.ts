import type { INestApplication } from '@nestjs/common';
import { attachmentUploadSchema, messageSchema } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bearer, startE2eApp, type E2eUser, type FakeS3Service } from './e2e-app.js';
import { hasInfra } from './helpers.js';

/** The first bytes of a WebM (EBML) file, as browsers record Opus voice. */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 7)]);
/** An AAC-in-MP4 recording, as Safari and the phones make. */
const M4A = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from('ftypM4A '),
  Buffer.alloc(200),
]);
const voice = { durationMs: 12_400, waveform: [3, 40, 100, 62, 10] };

describe.skipIf(!hasInfra)('voice messages (CHAT-074)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let closeAll: () => Promise<void>;
  let s3: FakeS3Service;

  beforeAll(async () => {
    ({ server, signUp, close: closeAll, s3 } = await startE2eApp('voice'));
  });
  afterAll(() => closeAll());

  async function setUp() {
    const [anna, ben] = [await signUp(), await signUp()];
    const res = await request(server())
      .post('/conversations/direct')
      .set(bearer(anna.token))
      .send({ userId: ben.id })
      .expect(201);
    return { anna, ben, conversationId: res.body.id as string };
  }

  async function record(
    user: E2eUser,
    conversationId: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<string> {
    const res = await request(server())
      .post(`/conversations/${conversationId}/attachments`)
      .set(bearer(user.token))
      .send({ filename: 'Voice message.webm', contentType, sizeBytes: bytes.length, voice })
      .expect(201);
    const upload = attachmentUploadSchema.parse(res.body);
    s3.upload(upload.uploadUrl, bytes, contentType);
    return upload.attachmentId;
  }

  const send = (user: E2eUser, conversationId: string, attachmentId: string) =>
    request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(user.token))
      .send({ clientMsgId: randomUUID(), attachmentId });

  it('sends a voice message that plays inline, with its length and waveform', async () => {
    const { anna, ben, conversationId } = await setUp();
    const attachmentId = await record(anna, conversationId, WEBM, 'audio/webm;codecs=opus');
    const sent = messageSchema.parse(
      (await send(anna, conversationId, attachmentId).expect(201)).body,
    );
    expect(sent.type).toBe('file');
    expect(sent.attachment).toMatchObject({ kind: 'file', contentType: 'audio/webm', voice });

    const url = await request(server())
      .get(`/attachments/${attachmentId}/url`)
      .set(bearer(ben.token))
      .expect(200);
    // Inline (a signed GET with its audio type), not a download.
    expect(url.body.url).toContain('op=get');

    const inbox = await request(server()).get('/conversations').set(bearer(ben.token));
    expect(inbox.body[0].lastMessage.attachment).toMatchObject({ voice });

    // Nothing to edit in a voice message.
    await request(server())
      .patch(`/conversations/${conversationId}/messages/${sent.id}`)
      .set(bearer(anna.token))
      .send({ body: 'transcript' })
      .expect(400);
  });

  it('accepts AAC in MP4 from Safari and the phones', async () => {
    const { anna, conversationId } = await setUp();
    const attachmentId = await record(anna, conversationId, M4A, 'audio/mp4');
    const sent = await send(anna, conversationId, attachmentId).expect(201);
    expect(sent.body.attachment.voice).toEqual(voice);
  });

  it('refuses anything that is not really a recording, or too long', async () => {
    const { anna, conversationId } = await setUp();
    // Not an audio type at all.
    await request(server())
      .post(`/conversations/${conversationId}/attachments`)
      .set(bearer(anna.token))
      .send({ filename: 'x.html', contentType: 'text/html', sizeBytes: 10, voice })
      .expect(400);
    // Longer than 5 minutes, or bigger than a recording can be.
    await request(server())
      .post(`/conversations/${conversationId}/attachments`)
      .set(bearer(anna.token))
      .send({
        filename: 'v.webm',
        contentType: 'audio/webm',
        sizeBytes: 10,
        voice: { durationMs: 301_000, waveform: [1] },
      })
      .expect(400);
    await request(server())
      .post(`/conversations/${conversationId}/attachments`)
      .set(bearer(anna.token))
      .send({ filename: 'v.webm', contentType: 'audio/webm', sizeBytes: 9 * 1024 * 1024, voice })
      .expect(400);

    // Claims WebM but the bytes are HTML: refused, and nothing is kept.
    const fake = await record(
      anna,
      conversationId,
      Buffer.from('<html><script>alert(1)</script></html>'),
      'audio/webm',
    );
    const res = await send(anna, conversationId, fake).expect(400);
    expect(res.body.message).toMatch(/voice recording/);
    expect([...s3.objects.keys()].some((k) => k.includes(fake))).toBe(false);
  });
});
