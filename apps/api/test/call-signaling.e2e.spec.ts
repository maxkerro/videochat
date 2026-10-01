import type { INestApplication } from '@nestjs/common';
import { CALL_EVENTS } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createDb, createPool } from '../src/db/client.js';
import { calls } from '../src/db/schema.js';
import { bearer, startE2eApp, type E2eUser, type TestSocket } from './e2e-app.js';
import { hasInfra } from './helpers.js';

// Short timers so the timeout paths run in seconds, not the production 30 s / 20 s. Set before
// the app boots (in beforeAll), which is when the env is first read in this test process.
process.env.CALL_RING_TIMEOUT_SEC = '2';
process.env.CALL_RECONNECT_GRACE_SEC = '2';

describe.skipIf(!hasInfra)('call signalling over WebSocket (CHAT-041)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let connect: (user: E2eUser) => Promise<TestSocket>;
  let closeAll: () => Promise<void>;
  const pool = () => createPool(process.env.TEST_DATABASE_URL!, 1);

  beforeAll(async () => {
    ({ server, signUp, connect, close: closeAll } = await startE2eApp('sig'));
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

  async function callRow(id: string) {
    const p = pool();
    try {
      const [row] = await createDb(p).select().from(calls).where(eq(calls.id, id));
      return row;
    } finally {
      await p.end();
    }
  }

  /** caller + callee (with two devices) in a fresh DM. */
  async function setUp() {
    const caller = await signUp();
    const callee = await signUp();
    const conversationId = await directChat(caller, callee);
    const callerSocket = await connect(caller);
    const calleeLaptop = await connect(callee);
    const calleePhone = await connect(callee);
    return { caller, callee, conversationId, callerSocket, calleeLaptop, calleePhone };
  }

  const byCall = (callId: string) => (p: Record<string, unknown>) => p.callId === callId;

  it('rings every online device of the callee, and tells the caller once one is ringing', async () => {
    const { caller, conversationId, callerSocket, calleeLaptop, calleePhone } = await setUp();
    const callId = randomUUID();

    callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'video' });

    for (const device of [calleeLaptop, calleePhone]) {
      const incoming = await device.waitFor(CALL_EVENTS.incoming, byCall(callId));
      expect(incoming.payload).toMatchObject({
        callId,
        conversationId,
        media: 'video',
        caller: { id: caller.id },
      });
    }
    calleePhone.send(CALL_EVENTS.ringing, { callId });
    await callerSocket.waitFor(CALL_EVENTS.ringing, byCall(callId));
  });

  it('answering on one device stops the others ringing ("answered elsewhere")', async () => {
    const { conversationId, callerSocket, calleeLaptop, calleePhone } = await setUp();
    const callId = randomUUID();
    callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'audio' });
    await calleePhone.waitFor(CALL_EVENTS.incoming, byCall(callId));

    calleePhone.send(CALL_EVENTS.accept, { callId });

    const winner = calleePhone.connectionId;
    for (const s of [callerSocket, calleeLaptop, calleePhone]) {
      const accepted = await s.waitFor(CALL_EVENTS.accepted, byCall(callId), 1000);
      expect(accepted.payload).toEqual({ callId, connectionId: winner });
    }
    // A late answer from the other device doesn't take the call over.
    calleeLaptop.send(CALL_EVENTS.accept, { callId });
    await calleeLaptop.expectNone(
      CALL_EVENTS.accepted,
      (p) => p.callId === callId && p.connectionId === calleeLaptop.connectionId,
    );
    expect((await callRow(callId))?.calleeConnectionId).toBe(winner);
  });

  it('relays offer/answer/ICE/media only between the two connections in the call', async () => {
    const { conversationId, callerSocket, calleeLaptop, calleePhone } = await setUp();
    const callId = randomUUID();
    callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'video' });
    await calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(callId));
    calleeLaptop.send(CALL_EVENTS.accept, { callId });
    await callerSocket.waitFor(CALL_EVENTS.accepted, byCall(callId));

    callerSocket.send(CALL_EVENTS.offer, { callId, sdp: 'v=0 offer' });
    const offer = await calleeLaptop.waitFor(CALL_EVENTS.offer, byCall(callId));
    expect(offer.payload).toEqual({ callId, sdp: 'v=0 offer' });

    calleeLaptop.send(CALL_EVENTS.answer, { callId, sdp: 'v=0 answer' });
    await callerSocket.waitFor(CALL_EVENTS.answer, byCall(callId));

    const candidate = { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0' };
    callerSocket.send(CALL_EVENTS.ice, { callId, candidate });
    const ice = await calleeLaptop.waitFor(CALL_EVENTS.ice, byCall(callId));
    expect(ice.payload).toMatchObject({ callId, candidate });

    calleeLaptop.send(CALL_EVENTS.media, { callId, audio: false, video: true });
    const media = await callerSocket.waitFor(CALL_EVENTS.media, byCall(callId));
    expect(media.payload).toEqual({ callId, audio: false, video: true });

    // The callee's other device is not in the call and hears none of the negotiation.
    await calleePhone.expectNone(CALL_EVENTS.offer, byCall(callId));
    await calleePhone.expectNone(CALL_EVENTS.ice, byCall(callId));
  });

  it('declining ends the call for the caller and every callee device', async () => {
    const { conversationId, callerSocket, calleeLaptop, calleePhone } = await setUp();
    const callId = randomUUID();
    callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'audio' });
    await calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(callId));

    calleeLaptop.send(CALL_EVENTS.decline, { callId });

    for (const s of [callerSocket, calleeLaptop, calleePhone]) {
      const ended = await s.waitFor(CALL_EVENTS.ended, byCall(callId));
      expect(ended.payload).toEqual({ callId, reason: 'declined' });
    }
  });

  it('cancelling before an answer stops every callee device ringing', async () => {
    const { conversationId, callerSocket, calleeLaptop, calleePhone } = await setUp();
    const callId = randomUUID();
    callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'audio' });
    await calleePhone.waitFor(CALL_EVENTS.incoming, byCall(callId));

    callerSocket.send(CALL_EVENTS.cancel, { callId });

    for (const s of [calleeLaptop, calleePhone]) {
      const ended = await s.waitFor(CALL_EVENTS.ended, byCall(callId));
      expect(ended.payload).toEqual({ callId, reason: 'cancelled' });
    }
  });

  it('either side hanging up an answered call ends it for both', async () => {
    const { conversationId, callerSocket, calleeLaptop } = await setUp();
    const callId = randomUUID();
    callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'video' });
    await calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(callId));
    calleeLaptop.send(CALL_EVENTS.accept, { callId });
    await callerSocket.waitFor(CALL_EVENTS.accepted, byCall(callId));

    calleeLaptop.send(CALL_EVENTS.end, { callId });

    for (const s of [callerSocket, calleeLaptop]) {
      const ended = await s.waitFor(CALL_EVENTS.ended, byCall(callId));
      expect(ended.payload).toEqual({ callId, reason: 'completed' });
    }
    const row = await callRow(callId);
    expect(row?.status).toBe('ended');
    expect(row?.answeredAt).not.toBeNull();
    expect(row?.endedAt).not.toBeNull();
  });

  it('an unanswered call ends after the ring timeout and is logged as missed', async () => {
    const { conversationId, callerSocket, calleeLaptop } = await setUp();
    const callId = randomUUID();
    callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'audio' });
    await calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(callId));

    for (const s of [callerSocket, calleeLaptop]) {
      const ended = await s.waitFor(CALL_EVENTS.ended, byCall(callId), 6000);
      expect(ended.payload).toEqual({ callId, reason: 'missed' });
    }
    expect(await callRow(callId)).toMatchObject({ status: 'ended', endReason: 'missed' });
  });

  it('tells the caller the callee is busy when they are already in a call', async () => {
    const { conversationId, callerSocket, calleeLaptop, callee } = await setUp();
    const first = randomUUID();
    callerSocket.send(CALL_EVENTS.invite, { callId: first, conversationId, media: 'audio' });
    await calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(first));
    calleeLaptop.send(CALL_EVENTS.accept, { callId: first });
    await callerSocket.waitFor(CALL_EVENTS.accepted, byCall(first));

    const other = await signUp();
    const otherChat = await directChat(other, callee);
    const otherSocket = await connect(other);
    const second = randomUUID();
    otherSocket.send(CALL_EVENTS.invite, {
      callId: second,
      conversationId: otherChat,
      media: 'audio',
    });

    const ended = await otherSocket.waitFor(CALL_EVENTS.ended, byCall(second));
    expect(ended.payload).toEqual({ callId: second, reason: 'busy' });
    await calleeLaptop.expectNone(CALL_EVENTS.incoming, byCall(second));
  });

  it('a caller whose socket drops while ringing cancels the call', async () => {
    const { conversationId, callerSocket, calleeLaptop } = await setUp();
    const callId = randomUUID();
    callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'audio' });
    await calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(callId));

    callerSocket.close();

    const ended = await calleeLaptop.waitFor(CALL_EVENTS.ended, byCall(callId));
    expect(ended.payload).toEqual({ callId, reason: 'cancelled' });
  });

  describe('only members of the DM can signal each other', () => {
    it('refuses a call into a conversation the caller is not a member of', async () => {
      const { conversationId, calleeLaptop } = await setUp();
      const outsider = await signUp();
      const outsiderSocket = await connect(outsider);
      const callId = randomUUID();

      outsiderSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'audio' });

      const ended = await outsiderSocket.waitFor(CALL_EVENTS.ended, byCall(callId));
      expect(ended.payload).toEqual({ callId, reason: 'unavailable' });
      await calleeLaptop.expectNone(CALL_EVENTS.incoming, byCall(callId));
    });

    it('refuses a call into a group conversation (calls are 1:1)', async () => {
      const a = await signUp();
      const b = await signUp();
      const group = await request(server())
        .post('/conversations/group')
        .set(bearer(a.token))
        .send({ title: 'Team', memberIds: [b.id] })
        .expect(201);
      const socket = await connect(a);
      const callId = randomUUID();

      socket.send(CALL_EVENTS.invite, {
        callId,
        conversationId: group.body.id as string,
        media: 'audio',
      });

      const ended = await socket.waitFor(CALL_EVENTS.ended, byCall(callId));
      expect(ended.payload).toEqual({ callId, reason: 'unavailable' });
    });

    it("an outsider cannot answer, hang up, or inject negotiation into someone else's call", async () => {
      const { conversationId, callerSocket, calleeLaptop } = await setUp();
      const callId = randomUUID();
      callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'audio' });
      await calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(callId));

      const outsider = await connect(await signUp());
      outsider.send(CALL_EVENTS.accept, { callId });
      outsider.send(CALL_EVENTS.decline, { callId });
      outsider.send(CALL_EVENTS.offer, { callId, sdp: 'v=0 evil' });

      await callerSocket.expectNone(CALL_EVENTS.accepted, byCall(callId));
      await callerSocket.expectNone(CALL_EVENTS.ended, byCall(callId));
      await calleeLaptop.expectNone(CALL_EVENTS.offer, byCall(callId));
      expect((await callRow(callId))?.status).toBe('ringing');
    });

    it('blocking is silent: a blocked caller "rings" but the callee is never told', async () => {
      const { caller, callee, conversationId, callerSocket, calleeLaptop } = await setUp();
      await request(server())
        .post(`/users/${caller.id}/block`)
        .set(bearer(callee.token))
        .expect(200);
      const callId = randomUUID();

      callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'audio' });

      await calleeLaptop.expectNone(CALL_EVENTS.incoming, byCall(callId), 600);
      // No immediate refusal that would reveal the block -- it times out like any unanswered call.
      await callerSocket.expectNone(CALL_EVENTS.ended, byCall(callId), 300);
      const ended = await callerSocket.waitFor(CALL_EVENTS.ended, byCall(callId), 6000);
      expect(ended.payload).toEqual({ callId, reason: 'missed' });
      await calleeLaptop.expectNone(CALL_EVENTS.ended, byCall(callId), 100);
    });
  });
  describe('network resilience (CHAT-043)', () => {
    async function liveCall() {
      const ctx = await setUp();
      const callId = randomUUID();
      ctx.callerSocket.send(CALL_EVENTS.invite, {
        callId,
        conversationId: ctx.conversationId,
        media: 'video',
      });
      await ctx.calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(callId));
      ctx.calleeLaptop.send(CALL_EVENTS.accept, { callId });
      await ctx.callerSocket.waitFor(CALL_EVENTS.accepted, byCall(callId));
      return { ...ctx, callId };
    }

    it('a participant whose socket reconnects re-attaches to the call and negotiation flows again', async () => {
      const { caller, callerSocket, calleeLaptop, callId } = await liveCall();

      callerSocket.close();
      const fresh = await connect(caller);
      fresh.send(CALL_EVENTS.resume, { callId });

      await fresh.waitFor(CALL_EVENTS.resume, byCall(callId));
      await calleeLaptop.waitFor(CALL_EVENTS.resume, byCall(callId));
      fresh.send(CALL_EVENTS.offer, { callId, sdp: 'v=0 ice-restart' });
      const offer = await calleeLaptop.waitFor(
        CALL_EVENTS.offer,
        (p) => p.callId === callId && p.sdp === 'v=0 ice-restart',
      );
      expect(offer).toBeDefined();
      expect((await callRow(callId))?.callerConnectionId).toBe(fresh.connectionId);
      expect((await callRow(callId))?.callerDisconnectedAt).toBeNull();
    });

    it('ends the call as connection-lost if the participant does not come back in time', async () => {
      const { callerSocket, calleeLaptop, callId } = await liveCall();

      callerSocket.close();

      const ended = await calleeLaptop.waitFor(CALL_EVENTS.ended, byCall(callId), 8000);
      expect(ended.payload).toEqual({ callId, reason: 'connection-lost' });
    });

    it("cannot resume someone else's call", async () => {
      const { callId } = await liveCall();
      const outsider = await connect(await signUp());
      outsider.send(CALL_EVENTS.resume, { callId });
      await outsider.expectNone(CALL_EVENTS.resume, byCall(callId));
    });
  });

  describe('POST /calls/:id/stats (CHAT-043)', () => {
    const stats = {
      durationSec: 125,
      rttMsAvg: 80,
      packetLossPctMax: 1.5,
      outgoingKbpsMin: 900,
      reconnects: 1,
      hadVideo: true,
      endCause: 'completed',
    };

    it("records a participant's end-of-call summary", async () => {
      const { caller, callerSocket, calleeLaptop, conversationId } = await setUp();
      const callId = randomUUID();
      callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'video' });
      await calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(callId));

      await request(server())
        .post(`/calls/${callId}/stats`)
        .set(bearer(caller.token))
        .send(stats)
        .expect(204);
      const metrics = await request(server()).get('/metrics').expect(200);
      expect(metrics.text).toMatch(/call_stats_reports_total\{end_cause="completed"\} 1/);
    });

    it('404s for someone who was not in the call', async () => {
      const { callerSocket, calleeLaptop, conversationId } = await setUp();
      const callId = randomUUID();
      callerSocket.send(CALL_EVENTS.invite, { callId, conversationId, media: 'audio' });
      await calleeLaptop.waitFor(CALL_EVENTS.incoming, byCall(callId));
      const outsider = await signUp();

      await request(server())
        .post(`/calls/${callId}/stats`)
        .set(bearer(outsider.token))
        .send(stats)
        .expect(404);
    });

    it('rejects a malformed summary', async () => {
      const user = await signUp();
      await request(server())
        .post(`/calls/${randomUUID()}/stats`)
        .set(bearer(user.token))
        .send({ ...stats, packetLossPctMax: 250 })
        .expect(400);
    });
  });
});
