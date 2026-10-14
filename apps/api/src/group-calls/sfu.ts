import { Inject, Injectable } from '@nestjs/common';
import { GROUP_CALL_MAX_PARTICIPANTS } from '@videochat/shared';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import type { Env } from '../config/env.js';
import { ENV } from '../infra/tokens.js';

/** How long a new room waits for its first person, and lingers after the last one leaves. */
export const ROOM_EMPTY_TIMEOUT_SEC = 60;
export const ROOM_DEPARTURE_TIMEOUT_SEC = 15;
/** A join token only has to last until the client connects; LiveKit renews it from then on. */
export const JOIN_TOKEN_TTL_SEC = 10 * 60;

export interface SfuRoom {
  name: string;
  numParticipants: number;
}

/** The small part of the SFU (LiveKit) the group calls need. An interface so tests use a fake. */
export interface Sfu {
  readonly enabled: boolean;
  /** Where clients connect (`wss://...`). */
  readonly url: string;
  createRoom(name: string): Promise<void>;
  /** The rooms among `names` that exist right now. */
  listRooms(names: string[]): Promise<SfuRoom[]>;
  /** `identity` is unique per connection; `userId` goes into the token's attributes. */
  joinToken(room: string, identity: string, displayName: string): Promise<string>;
  /** The identities connected to `room` now. */
  listIdentities(room: string): Promise<string[]>;
  /** Resolves also when that connection is already gone (another node removed it first). */
  removeIdentity(room: string, identity: string): Promise<void>;
  /** Closes a room, disconnecting everyone in it. Resolves also when it no longer exists. */
  deleteRoom(room: string): Promise<void>;
}

/** The control API's answer for a room or participant that doesn't exist (any more). */
export function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string } | null;
  return (
    e?.status === 404 ||
    e?.code === 'not_found' ||
    /not.?found|does not exist/i.test(e?.message ?? '')
  );
}

/** One identity per connection, so the same person on two devices doesn't knock one of them out
 *  (LiveKit drops the older connection of a duplicate identity). */
export function connectionIdentity(userId: string, connectionId: string): string {
  return `${userId}:${connectionId}`;
}

export function userOfIdentity(identity: string): string {
  return identity.split(':')[0]!;
}

export const SFU = Symbol('SFU');

/** The control API wants http(s) where clients use ws(s). */
export function controlUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, 'http$1://');
}

/** CHAT-070: LiveKit (Cloud in staging/production, the docker compose service locally). */
@Injectable()
export class LiveKitSfu implements Sfu {
  readonly enabled: boolean;
  readonly url: string;
  private readonly rooms: RoomServiceClient | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.url = env.LIVEKIT_URL;
    this.enabled = Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
    this.rooms = this.enabled
      ? new RoomServiceClient(
          controlUrl(env.LIVEKIT_URL),
          env.LIVEKIT_API_KEY,
          env.LIVEKIT_API_SECRET,
        )
      : null;
  }

  async createRoom(name: string): Promise<void> {
    await this.rooms!.createRoom({
      name,
      emptyTimeout: ROOM_EMPTY_TIMEOUT_SEC,
      departureTimeout: ROOM_DEPARTURE_TIMEOUT_SEC,
      maxParticipants: GROUP_CALL_MAX_PARTICIPANTS,
    });
  }

  async listIdentities(room: string): Promise<string[]> {
    return (await this.rooms!.listParticipants(room)).map((p) => p.identity);
  }

  async removeIdentity(room: string, identity: string): Promise<void> {
    try {
      await this.rooms!.removeParticipant(room, identity);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async deleteRoom(room: string): Promise<void> {
    try {
      await this.rooms!.deleteRoom(room);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async listRooms(names: string[]): Promise<SfuRoom[]> {
    const rooms = await this.rooms!.listRooms(names);
    return rooms.map((r) => ({ name: r.name, numParticipants: r.numParticipants }));
  }

  async joinToken(room: string, identity: string, displayName: string): Promise<string> {
    const token = new AccessToken(this.env.LIVEKIT_API_KEY, this.env.LIVEKIT_API_SECRET, {
      identity,
      name: displayName,
      ttl: JOIN_TOKEN_TTL_SEC,
    });
    // Audio/video only: the chat itself stays in the app, so no data channel publishing.
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    return token.toJwt();
  }
}
