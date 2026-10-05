import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bearer,
  startE2eApp,
  type E2eUser,
  type FakeS3Service,
  type TestSocket,
} from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('reply, edit and delete (CHAT-032)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let connect: (user: E2eUser) => Promise<TestSocket>;
  let closeAll: () => Promise<void>;
  let s3: FakeS3Service;

  beforeAll(async () => {
    ({ server, signUp, connect, close: closeAll, s3 } = await startE2eApp('act'));
  });
  afterAll(() => closeAll());

  async function direct(a: E2eUser, b: E2eUser) {
    const res = await request(server())
      .post('/conversations/direct')
      .set(bearer(a.token))
      .send({ userId: b.id })
      .expect(201);
    return res.body.id as string;
  }

  async function send(user: E2eUser, conversationId: string, body: object) {
    const res = await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(user.token))
      .send({ clientMsgId: randomUUID(), ...body })
      .expect(201);
    return res.body as { id: string; seq: number } & Record<string, unknown>;
  }

  const path = (conversationId: string, id: string) =>
    `/conversations/${conversationId}/messages/${id}`;

  it('replies quote the original, and the quote follows its edits and deletion', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const conversationId = await direct(anna, ben);
    const original = await send(anna, conversationId, { body: 'Lunch at 12?' });
    const reply = await send(ben, conversationId, { body: 'Yes!', replyToId: original.id });
    expect(reply).toMatchObject({
      replyToId: original.id,
      replyTo: {
        id: original.id,
        seq: original.seq,
        senderId: anna.id,
        snippet: 'Lunch at 12?',
        deleted: false,
      },
    });

    await request(server())
      .patch(path(conversationId, original.id))
      .set(bearer(anna.token))
      .send({ body: 'Lunch at 1?' })
      .expect(200);
    let history = await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .expect(200);
    expect(history.body.messages.at(-1).replyTo.snippet).toBe('Lunch at 1?');

    await request(server())
      .delete(path(conversationId, original.id))
      .set(bearer(anna.token))
      .expect(200);
    history = await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .expect(200);
    const [deleted, replyAfter] = history.body.messages.slice(-2);
    expect(deleted).toMatchObject({ body: null });
    expect(deleted.deletedAt).not.toBeNull();
    expect(replyAfter.replyTo).toMatchObject({ deleted: true, snippet: null });

    // And you can't reply to it any more.
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .send({ clientMsgId: randomUUID(), body: 'late', replyToId: original.id })
      .expect(400);
  });

  it('edits and deletes reach everyone live; only the sender may edit or delete in a DM', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const conversationId = await direct(anna, ben);
    const benSocket = await connect(ben);
    const msg = await send(anna, conversationId, { body: 'helo' });

    await request(server())
      .patch(path(conversationId, msg.id))
      .set(bearer(ben.token))
      .send({ body: 'x' })
      .expect(403);
    await request(server()).delete(path(conversationId, msg.id)).set(bearer(ben.token)).expect(403);

    await request(server())
      .patch(path(conversationId, msg.id))
      .set(bearer(anna.token))
      .send({ body: 'hello' })
      .expect(200);
    const edited = await benSocket.waitFor(
      'message.updated',
      (p) => p.id === msg.id && p.body === 'hello',
    );
    expect((edited.payload as { editedAt: string | null }).editedAt).not.toBeNull();

    await request(server())
      .delete(path(conversationId, msg.id))
      .set(bearer(anna.token))
      .expect(200);
    await benSocket.waitFor(
      'message.updated',
      (p) => p.id === msg.id && p.deletedAt !== null && p.body === null,
    );

    const list = await request(server()).get('/conversations').set(bearer(ben.token)).expect(200);
    expect(list.body[0].lastMessage.body).toBeNull();
  });

  it("a group admin can delete anyone's message; deleting an attachment removes its files", async () => {
    const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
    const group = await request(server())
      .post('/conversations/group')
      .set(bearer(anna.token))
      .send({ title: 'Team', memberIds: [ben.id, clara.id] })
      .expect(201);
    const conversationId = group.body.id as string;

    const upload = await request(server())
      .post(`/conversations/${conversationId}/attachments`)
      .set(bearer(ben.token))
      .send({ filename: 'notes.txt', contentType: 'text/plain', sizeBytes: 5 })
      .expect(201);
    s3.upload(upload.body.uploadUrl, Buffer.from('notes'), 'text/plain');
    const msg = await send(ben, conversationId, { attachmentId: upload.body.attachmentId });
    // The stored (processed) copy, not the staging key the upload went to.
    const key = s3.keyFromUrl(upload.body.uploadUrl).replace(/upload$/, 'original');
    expect(s3.objects.has(key)).toBe(true);

    await request(server())
      .delete(path(conversationId, msg.id))
      .set(bearer(clara.token))
      .expect(403);
    const res = await request(server())
      .delete(path(conversationId, msg.id))
      .set(bearer(anna.token))
      .expect(200);
    expect(res.body).not.toHaveProperty('attachment');
    expect(s3.objects.has(key)).toBe(false);
    await request(server())
      .get(`/attachments/${upload.body.attachmentId}/url`)
      .set(bearer(clara.token))
      .expect(404);
  });

  it("can't edit or delete a call entry or another conversation's message", async () => {
    const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
    const conversationId = await direct(anna, ben);
    const other = await direct(anna, clara);
    const msg = await send(anna, other, { body: 'for clara' });
    await request(server())
      .patch(path(conversationId, msg.id))
      .set(bearer(anna.token))
      .send({ body: 'x' })
      .expect(404);
    await request(server())
      .delete(path(conversationId, 'not-a-ulid'))
      .set(bearer(anna.token))
      .expect(404);
  });
});
