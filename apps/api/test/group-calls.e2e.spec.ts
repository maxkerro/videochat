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
import { createPool } from '../src/db/client.js';
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
    expect(res.token).toMatch(new RegExp(`^token-${res.call.id}-${anna.id}:`));
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
    expect(second.token).toMatch(new RegExp(`^token-${first.call.id}-${clara.id}:`));
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

  it('takes people out of the call when they leave the group or are removed from it', async () => {
    const { anna, ben, clara, conversationId } = await group();
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    await join(ben, conversationId);
    await join(clara, conversationId);
    sfu.connect(call.id);

    await request(server())
      .delete(`/conversations/${conversationId}/members/${ben.id}`)
      .set(bearer(anna.token))
      .expect((r) => expect(r.status).toBeLessThan(300));
    await request(server())
      .post(`/conversations/${conversationId}/leave`)
      .set(bearer(clara.token))
      .expect((r) => expect(r.status).toBeLessThan(300));

    // Done in the background (a slow SFU must not hold up the removal).
    await vi.waitFor(() =>
      expect(sfu.removedUsers(call.id).sort()).toEqual([ben.id, clara.id].sort()),
    );
    expect(await sfu.listIdentities(call.id)).toEqual([
      expect.stringMatching(new RegExp(`^${anna.id}:`)),
    ]);
    // ...and they can't get a new token.
    await join(ben, conversationId, 404);
    await join(clara, conversationId, 404);
    await request(server())
      .get(`/conversations/${conversationId}/group-call`)
      .set(bearer(ben.token))
      .expect(404);
  });

  it('removes a former member who comes back with a token they kept', async () => {
    const { anna, ben, conversationId } = await group();
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    await join(ben, conversationId); // Ben's token, issued while he was a member
    sfu.connect(call.id, anna.id);
    await request(server())
      .delete(`/conversations/${conversationId}/members/${ben.id}`)
      .set(bearer(anna.token))
      .expect((r) => expect(r.status).toBeLessThan(300));

    // He wasn't connected when he was removed (or reconnects later with the kept token)...
    sfu.connect(call.id, ben.id);
    expect(sfu.removedUsers(call.id)).not.toContain(ben.id);
    // ...and the next sweep takes him out again; members stay.
    await service.sweep();
    expect(sfu.removedUsers(call.id)).toContain(ben.id);
    expect(sfu.removedUsers(call.id)).not.toContain(anna.id);
  });

  it('does not hand out a room for a call the sweep ended a moment ago', async () => {
    const { anna, ben, conversationId } = await group();
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    // The sweep ends the call right as Ben's join recreates its room.
    const original = sfu.createRoom.bind(sfu);
    sfu.createRoom = async (name: string) => {
      await original(name);
      if (name === call.id) {
        sfu.closeRoom(call.id);
        await service.sweep(later(GROUP_CALL_START_GRACE_MS));
      }
    };
    try {
      const res = groupCallJoinSchema.parse((await join(ben, conversationId)).body);
      expect(res.call.id).not.toBe(call.id);
      expect((await running(anna, conversationId))?.id).toBe(res.call.id);
    } finally {
      sfu.createRoom = original;
    }
  });

  it('gives each device its own identity, so a second device does not knock out the first', async () => {
    const { anna, conversationId } = await group();
    const first = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    const second = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    expect(first.token).not.toBe(second.token);
    const identities = sfu.tokens.filter((t) => t.room === first.call.id).map((t) => t.identity);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('makes sure the room exists, with its settings, for every join', async () => {
    const { anna, ben, conversationId } = await group();
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    sfu.closeRoom(call.id); // closed a moment ago; the sweep hasn't noticed yet
    await join(ben, conversationId);
    expect(sfu.creates.filter((n) => n === call.id)).toHaveLength(2);
    expect(sfu.rooms.has(call.id)).toBe(true);
  });

  it('starts exactly one call when two people press "Group call" at once', async () => {
    const { anna, ben, conversationId } = await group();
    const annaSocket = await connect(anna);
    const [a, b] = await Promise.all([join(anna, conversationId), join(ben, conversationId)]);
    expect(groupCallJoinSchema.parse(a.body).call.id).toBe(
      groupCallJoinSchema.parse(b.body).call.id,
    );
    await annaSocket.waitFor(GROUP_CALL_EVENTS.updated);
    await new Promise((r) => setTimeout(r, 400)); // room for a (wrong) second announcement
    const started = annaSocket.received.filter(
      (e) =>
        e.type === 'message.new' && /started a group call/.test((e.payload as Message).body ?? ''),
    );
    expect(started).toHaveLength(1);
  });

  it('removes someone whose account was deleted', async () => {
    const { anna, ben, conversationId } = await group();
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    await join(ben, conversationId);
    sfu.connect(call.id);
    const pool = createPool(process.env.TEST_DATABASE_URL!, 1);
    try {
      await pool.query('update users set deleted_at = now() where id = $1', [ben.id]);
    } finally {
      await pool.end();
    }
    await service.sweep();
    expect(sfu.removedUsers(call.id)).toEqual([ben.id]);
  });

  it('does not end a call whose room a join re-created during the sweep', async () => {
    const { anna, conversationId } = await group();
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    sfu.closeRoom(call.id);
    // First look: gone. Second look (right before ending): a join has re-created it.
    const listRooms = sfu.listRooms.bind(sfu);
    let looks = 0;
    sfu.listRooms = async (names: string[]) => {
      looks += 1;
      if (looks === 2) sfu.rooms.set(call.id, 1);
      return listRooms(names);
    };
    try {
      await service.sweep(later(GROUP_CALL_START_GRACE_MS));
    } finally {
      sfu.listRooms = listRooms;
    }
    expect((await running(anna, conversationId))?.id).toBe(call.id);
  });

  it('closes the room of a call it ends, so nobody is left in a room no call points at', async () => {
    const { anna, conversationId } = await group();
    const { call } = groupCallJoinSchema.parse((await join(anna, conversationId)).body);
    sfu.closeRoom(call.id);
    await service.sweep(later(GROUP_CALL_START_GRACE_MS));
    expect(sfu.deleted).toContain(call.id);
  });
});
