import type { INestApplication } from '@nestjs/common';
import {
  GROUP_CALL_EVENTS,
  GROUP_CALL_MAX_PARTICIPANTS,
  activeGroupCallResponseSchema,
  groupCallJoinSchema,
  type GroupCallUpdated,
  type Message,
} from '@videochat/shared';
import request from 'supertest';
import {
  GROUP_CALL_START_GRACE_MS,
  GroupCallsService,
} from '../src/group-calls/group-calls.service.js';
import { bearer, startE2eApp, type E2eUser, type FakeSfu, type TestSocket } from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('group calls (CHAT-070)', () => {
  let app: INestApplication;
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let connect: (u: E2eUser) => Promise<TestSocket>;
  let sfu: FakeSfu;
  let service: GroupCallsService;

  beforeAll(async () => {
    ({ app, server, signUp, connect, sfu } = await startE2eApp('gcall'));
    service = app.get(GroupCallsService);
  });
  afterAll(() => app.close());

  async function group() {
    const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
    const res = await request(server())
      .post('/conversations/group')
      .set(bearer(anna.token))
      .send({ title: 'Team', memberIds: [ben.id, clara.id] })
      .expect(201);
    return { anna, ben, clara, conversationId: res.body.id as string };
  }
  const join = (user: E2eUser, conversationId: string, status = 200) =>
    request(server())
      .post(`/conversations/${conversationId}/group-call`)
      .set(bearer(user.token))
      .expect(status);
  const running = async (user: E2eUser, conversationId: string) =>
    activeGroupCallResponseSchema.parse(
      (
        await request(server())
          .get(`/conversations/${conversationId}/group-call`)
          .set(bearer(user.token))
          .expect(200)
      ).body,
    ).call;
  const later = (ms: number) => new Date(Date.now() + ms);

  it('starts a call, announces it in the chat, and hands out a token for the room', async () => {
    const { anna, ben, conversationId } = await group();
    const benSocket = await connect(ben);

    const res = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    expect(res.url).toBe('wss://sfu.test');
    expect(res.token).toBe(`token-${res.call.id}-${anna.id}`);
    expect(sfu.rooms.has(res.call.id)).toBe(true);

    const update = await benSocket.waitFor(GROUP_CALL_EVENTS.updated);
    expect((update.payload as GroupCallUpdated).call?.id).toBe(res.call.id);
    const note = await benSocket.waitFor(
      'message.new',
      (p) => (p as unknown as Message).type === 'system',
    );
    expect((note.payload as Message).body).toMatch(/started a group call/);
  });

  it('lets a late joiner join the running call instead of starting another', async () => {
    const { anna, clara, conversationId } = await group();
    const first = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    expect((await running(clara, conversationId))?.id).toBe(first.call.id);

    const second = groupCallJoinSchema.parse((await join(clara, conversationId)).body);
    expect(second.call.id).toBe(first.call.id);
    expect(second.token).toBe(`token-${first.call.id}-${clara.id}`);
  });

  it('keeps people outside the group out, and is for groups only', async () => {
    const { anna, conversationId } = await group();
    const outsider = await signUp();
    await join(outsider, conversationId, 404);
    await request(server())
      .get(`/conversations/${conversationId}/group-call`)
      .set(bearer(outsider.token))
      .expect(404);

    const direct = await request(server())
      .post('/conversations/direct')
      .set(bearer(anna.token))
      .send({ userId: outsider.id })
      .expect((r) => expect([200, 201]).toContain(r.status));
    await join(anna, direct.body.id as string, 400);
  });

  it('follows the participant count, and ends the call once the room is gone', async () => {
    const { anna, ben, conversationId } = await group();
    const benSocket = await connect(ben);
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);

    sfu.setParticipants(call.id, 3);
    await service.sweep();
    expect((await running(ben, conversationId))?.participantCount).toBe(3);

    sfu.closeRoom(call.id);
    await service.sweep(later(GROUP_CALL_START_GRACE_MS));
    expect(await running(ben, conversationId)).toBeNull();
    await benSocket.waitFor(
      GROUP_CALL_EVENTS.updated,
      (p) => (p as unknown as GroupCallUpdated).call === null,
    );
    const ended = await benSocket.waitFor('message.new', (p) =>
      /Group call ended/.test((p as unknown as Message).body ?? ''),
    );
    expect((ended.payload as Message).type).toBe('system');

    // The next "join" starts a fresh call.
    const next = groupCallJoinSchema.parse((await join(ben, conversationId)).body);
    expect(next.call.id).not.toBe(call.id);
  });

  it('does not end a brand-new call whose room the SFU does not list yet', async () => {
    const { anna, conversationId } = await group();
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    sfu.closeRoom(call.id);
    await service.sweep();
    expect((await running(anna, conversationId))?.id).toBe(call.id);
  });

  it('turns people away from a full call', async () => {
    const { anna, ben, conversationId } = await group();
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    sfu.setParticipants(call.id, GROUP_CALL_MAX_PARTICIPANTS);
    await service.sweep();
    await join(ben, conversationId, 409);
  });

  it('gives the call back when the SFU cannot create the room', async () => {
    const { anna, conversationId } = await group();
    sfu.failCreate = true;
    try {
      await join(anna, conversationId, 503);
    } finally {
      sfu.failCreate = false;
    }
    expect(await running(anna, conversationId)).toBeNull();
    await join(anna, conversationId, 200);
  });
});
