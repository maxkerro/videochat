import type { INestApplication } from '@nestjs/common';
import { searchResponseSchema, snippetParts, type SearchResponse } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bearer, startE2eApp, type E2eUser, type FakeS3Service } from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('message search (CHAT-072)', () => {
  let app: INestApplication;
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let s3: FakeS3Service;

  beforeAll(async () => {
    ({ app, server, signUp, s3 } = await startE2eApp('search'));
  });
  afterAll(() => app.close());

  const send = async (user: E2eUser, conversationId: string, body: string) =>
    (
      await request(server())
        .post(`/conversations/${conversationId}/messages`)
        .set(bearer(user.token))
        .send({ clientMsgId: randomUUID(), body })
        .expect(201)
    ).body as { id: string; seq: number };
  const search = async (user: E2eUser, params: Record<string, string>): Promise<SearchResponse> =>
    searchResponseSchema.parse(
      (await request(server()).get('/search').query(params).set(bearer(user.token)).expect(200))
        .body,
    );
  const bodies = (r: SearchResponse) => r.results.map((x) => x.message.body);

  async function setUp() {
    const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
    const direct = await request(server())
      .post('/conversations/direct')
      .set(bearer(anna.token))
      .send({ userId: ben.id })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const group = await request(server())
      .post('/conversations/group')
      .set(bearer(anna.token))
      .send({ title: 'Team', memberIds: [ben.id, clara.id] })
      .expect(201);
    return {
      anna,
      ben,
      clara,
      directId: direct.body.id as string,
      groupId: group.body.id as string,
    };
  }

  it('finds words by prefix, newest first, with the matches marked', async () => {
    const { anna, ben, directId } = await setUp();
    await send(anna, directId, 'The budget for Q3 is ready');
    await send(ben, directId, 'Thanks! Budgeting meeting tomorrow?');
    await send(ben, directId, 'Unrelated message');

    const res = await search(anna, { q: 'budg' });
    expect(bodies(res)).toEqual([
      'Thanks! Budgeting meeting tomorrow?',
      'The budget for Q3 is ready',
    ]);
    const parts = snippetParts(res.results[1]!.snippet);
    expect(parts.find((p) => p.match)?.text.toLowerCase()).toBe('budget');
  });

  it('needs every word, ignores case and punctuation, and works in any language', async () => {
    const { anna, directId } = await setUp();
    await send(anna, directId, 'Привет, это отчёт за квартал');
    await send(anna, directId, 'Grüße aus Berlin');
    expect(bodies(await search(anna, { q: 'ОТЧЁТ квартал' }))).toEqual([
      'Привет, это отчёт за квартал',
    ]);
    expect(bodies(await search(anna, { q: 'grüße berl' }))).toEqual(['Grüße aus Berlin']);
    expect(bodies(await search(anna, { q: 'grüße paris' }))).toEqual([]);
    expect(bodies(await search(anna, { q: '!!!' }))).toEqual([]);
  });

  it('only searches conversations the person is in right now', async () => {
    const { anna, ben, clara, directId, groupId } = await setUp();
    const secret = `confidential-${randomUUID().slice(0, 8)}`;
    await send(anna, directId, `${secret} between Anna and Ben`);
    await send(anna, groupId, `${secret} in the group`);

    // Clara is not in the direct chat.
    expect(bodies(await search(clara, { q: secret }))).toEqual([`${secret} in the group`]);
    // An outsider finds nothing at all.
    const outsider = await signUp();
    expect(bodies(await search(outsider, { q: secret }))).toEqual([]);
    // After leaving the group, Clara finds nothing there either.
    await request(server())
      .post(`/conversations/${groupId}/leave`)
      .set(bearer(clara.token))
      .expect((r) => expect(r.status).toBeLessThan(300));
    expect(bodies(await search(clara, { q: secret }))).toEqual([]);
    expect((await search(ben, { q: secret })).results).toHaveLength(2);
  });

  it('filters by conversation, person, date and files', async () => {
    const { anna, ben, directId, groupId } = await setUp();
    const word = `plan${randomUUID().slice(0, 6)}`;
    await send(anna, directId, `${word} from anna in direct`);
    await send(ben, groupId, `${word} from ben in group`);
    const upload = await request(server())
      .post(`/conversations/${groupId}/attachments`)
      .set(bearer(ben.token))
      .send({ filename: `${word}-slides.pdf`, contentType: 'application/pdf', sizeBytes: 5 })
      .expect(201);
    s3.upload(upload.body.uploadUrl, Buffer.from('%PDF-'), 'application/pdf');
    await request(server())
      .post(`/conversations/${groupId}/messages`)
      .set(bearer(ben.token))
      .send({ clientMsgId: randomUUID(), attachmentId: upload.body.attachmentId })
      .expect(201);

    expect((await search(anna, { q: word })).results).toHaveLength(3);
    expect(bodies(await search(anna, { q: word, conversationId: directId }))).toEqual([
      `${word} from anna in direct`,
    ]);
    expect((await search(anna, { q: word, from: ben.id })).results).toHaveLength(2);
    const files = await search(anna, { q: word, has: 'file' });
    expect(files.results).toHaveLength(1);
    expect(files.results[0]!.message.attachment?.filename).toBe(`${word}-slides.pdf`);
    expect(snippetParts(files.results[0]!.snippet).some((p) => p.match)).toBe(true);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await search(anna, { q: word, after: future })).results).toHaveLength(0);
    expect((await search(anna, { q: word, before: future })).results).toHaveLength(3);
  });

  it('leaves deleted messages out', async () => {
    const { anna, directId } = await setUp();
    const word = `oops${randomUUID().slice(0, 6)}`;
    const sent = await send(anna, directId, `${word} sent by mistake`);
    await request(server())
      .delete(`/conversations/${directId}/messages/${sent.id}`)
      .set(bearer(anna.token))
      .expect((r) => expect(r.status).toBeLessThan(300));
    expect((await search(anna, { q: word })).results).toHaveLength(0);
  });

  it('pages through many results without repeats', async () => {
    const { anna, directId } = await setUp();
    const word = `page${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 35; i += 1) await send(anna, directId, `${word} number ${i}`);
    const first = await search(anna, { q: word });
    expect(first.results).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    const second = await search(anna, { q: word, cursor: first.nextCursor! });
    expect(second.results).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first.results, ...second.results].map((r) => r.message.id));
    expect(ids.size).toBe(35);
    await request(server())
      .get('/search')
      .query({ q: word, cursor: 'garbage' })
      .set(bearer(anna.token))
      .expect(400);
  });

  it('requires signing in and a search', async () => {
    await request(server()).get('/search').query({ q: 'x' }).expect(401);
    const user = await signUp();
    await request(server()).get('/search').set(bearer(user.token)).expect(400);
  });
});
