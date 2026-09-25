import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LIMITS,
  makeEnvelope,
  type ConversationSummary,
  type MemberSummary,
} from '@videochat/shared';
import type { Database } from '../db/client.js';
import { DB } from '../infra/tokens.js';
import {
  addGroupMembers,
  countActiveMembers,
  createGroupConversation,
  findConversationForUser,
  findOrCreateDirectConversation,
  getMembership,
  leaveConversation,
  listActiveMembers,
  listConversationsForUser,
  renameConversation,
  type ConversationListRow,
} from '../db/conversations.js';
import { appendMessage } from '../db/messages.js';
import { findUserById } from '../db/users.js';
import { toMessage } from '../messages/message-mapper.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { S3Service } from '../storage/s3.service.js';
import { toConversationSummary } from './conversation-mapper.js';

/** "Anna", "Anna and Ben", "Anna, Ben and Carl" -- the join style used by every CHAT-018 system
 *  message that names more than one person (an "add members" call can add several at once). */
function formatNameList(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly s3: S3Service,
    private readonly realtime: RealtimeService,
  ) {}

  async startDirect(userId: string, otherUserId: string): Promise<ConversationSummary> {
    if (userId === otherUserId) {
      throw new BadRequestException("Can't start a conversation with yourself");
    }
    const other = await findUserById(this.db, otherUserId);
    if (!other) throw new NotFoundException('User not found');

    const conv = await findOrCreateDirectConversation(this.db, userId, otherUserId);
    // Whether this just created the conversation or found an existing one, make sure both
    // members' already-open sockets (if any) are registered for it -- otherwise a socket that
    // connected before this conversation existed would never hear the first message sent into
    // it (see RealtimeService.addConversationForUser).
    this.realtime.addConversationForUser(userId, conv.id);
    this.realtime.addConversationForUser(otherUserId, conv.id);
    const avatarUrl = await this.s3.getAvatarUrl(other.avatarKey);
    return toConversationSummary({ ...conv, peer: other }, avatarUrl);
  }

  /** CHAT-014: a single conversation, for a client that navigated straight to it (e.g. a
   *  reload) without the full list already in cache. 404s for a non-member, same as the
   *  message endpoints. */
  async getById(conversationId: string, userId: string): Promise<ConversationSummary> {
    const row = await findConversationForUser(this.db, conversationId, userId);
    if (!row) throw new NotFoundException('Conversation not found');
    const avatarUrl = row.peer ? await this.s3.getAvatarUrl(row.peer.avatarKey) : null;
    return toConversationSummary(row, avatarUrl);
  }

  async listForUser(userId: string): Promise<ConversationSummary[]> {
    const rows = await listConversationsForUser(this.db, userId);
    return Promise.all(
      rows.map(async (row) => {
        const avatarUrl = row.peer ? await this.s3.getAvatarUrl(row.peer.avatarKey) : null;
        return toConversationSummary(row, avatarUrl);
      }),
    );
  }

  /**
   * CHAT-018: creates a group with `creatorId` as its only admin. `memberIds` never includes the
   * creator (the schema/UI send only "everyone else"); this also silently drops the creator if a
   * client sends them anyway and de-duplicates, rather than erroring, since neither is a
   * meaningful validation failure worth bothering the person with.
   */
  async createGroup(
    creatorId: string,
    title: string,
    memberIds: string[],
  ): Promise<ConversationSummary> {
    const uniqueMemberIds = Array.from(new Set(memberIds.filter((id) => id !== creatorId)));
    const totalMembers = uniqueMemberIds.length + 1;
    if (totalMembers < 2) {
      throw new BadRequestException('A group needs at least one other member');
    }
    if (totalMembers > LIMITS.groupMaxMembers) {
      throw new BadRequestException(`A group can have at most ${LIMITS.groupMaxMembers} members`);
    }
    await this.requireUsersExist(uniqueMemberIds);

    const conv = await createGroupConversation(this.db, {
      title,
      createdBy: creatorId,
      memberIds: uniqueMemberIds,
    });
    // Mirrors `startDirect`'s own reasoning: an already-open socket for any of these members
    // (including the creator) snapshotted its conversations at connect time, before this one
    // existed, and would never hear the "created the group" system message below without this.
    for (const memberId of [creatorId, ...uniqueMemberIds]) {
      this.realtime.addConversationForUser(memberId, conv.id);
    }

    const creator = await findUserById(this.db, creatorId);
    await this.postSystemMessage(conv.id, `${creator!.displayName} created the group`);

    return toConversationSummary(conv, null);
  }

  /** CHAT-018: admin-only rename. */
  async rename(
    conversationId: string,
    userId: string,
    title: string,
  ): Promise<ConversationSummary> {
    const membership = await this.requireGroupAdmin(conversationId, userId);
    const actor = await findUserById(this.db, userId);
    const updated = await renameConversation(this.db, conversationId, title);
    await this.postSystemMessage(
      conversationId,
      `${actor!.displayName} renamed the group to "${title}"`,
    );
    return toConversationSummary(
      { ...updated, role: membership.role, lastReadSeq: membership.lastReadSeq },
      null,
    );
  }

  /**
   * CHAT-018: admin-only "add members". One combined system message per call ("Anna added Ben and
   * Carl") rather than one per person -- a single admin action reads as one event, and it avoids
   * flooding the conversation when someone adds a handful of people at once. Anyone in `memberIds`
   * who's already an active member is silently skipped rather than erroring (see
   * `addGroupMembers`'s own comment) and left out of the message.
   */
  async addMembers(
    conversationId: string,
    userId: string,
    memberIds: string[],
  ): Promise<ConversationSummary> {
    const membership = await this.requireGroupAdmin(conversationId, userId);
    const uniqueMemberIds = Array.from(new Set(memberIds));
    const currentCount = await countActiveMembers(this.db, conversationId);
    if (currentCount + uniqueMemberIds.length > LIMITS.groupMaxMembers) {
      throw new BadRequestException(`A group can have at most ${LIMITS.groupMaxMembers} members`);
    }
    const users = await this.requireUsersExist(uniqueMemberIds);

    const added = await addGroupMembers(this.db, conversationId, uniqueMemberIds);
    for (const memberId of added) this.realtime.addConversationForUser(memberId, conversationId);

    if (added.length > 0) {
      const actor = await findUserById(this.db, userId);
      const addedNames = users.filter((u) => added.includes(u.id)).map((u) => u.displayName);
      await this.postSystemMessage(
        conversationId,
        `${actor!.displayName} added ${formatNameList(addedNames)}`,
      );
    }

    // Re-fetches rather than reusing `membership` (captured before the adds above) so `lastSeq`
    // reflects the system message just posted, not the state before this call started.
    const refreshed = await this.requireGroup(conversationId, userId);
    return toConversationSummary(
      { ...refreshed, role: membership.role, lastReadSeq: membership.lastReadSeq },
      null,
    );
  }

  /** CHAT-018: admin-only removal of someone else. Use {@link leave} to remove yourself -- kept
   *  as two separate methods rather than one with a "kick or leave" flag, since they have
   *  different authorization rules (this one requires admin; `leave` doesn't) and different
   *  outcomes (this one can trigger last-admin promotion only via `leave`'s own path -- a removed
   *  admin's replacement is handled the same way a self-leave is, by calling through to the same
   *  {@link leaveConversation} DB function below). */
  async removeMember(conversationId: string, userId: string, targetUserId: string): Promise<void> {
    await this.requireGroupAdmin(conversationId, userId);
    if (targetUserId === userId) {
      throw new BadRequestException('Use leave to remove yourself');
    }
    const target = await findUserById(this.db, targetUserId);
    if (!target) throw new NotFoundException('User not found');

    const result = await leaveConversation(this.db, conversationId, targetUserId);
    if (!result.left) throw new NotFoundException('User is not a member of this conversation');
    // AC: "removed members stop receiving messages immediately".
    this.realtime.removeConversationForUser(targetUserId, conversationId);

    const actor = await findUserById(this.db, userId);
    await this.postSystemMessage(
      conversationId,
      `${actor!.displayName} removed ${target.displayName}`,
    );
    await this.announcePromotionIfAny(conversationId, result.promotedUserId);
  }

  /** CHAT-018: leaving is available to any member, no admin check. If the leaver was the group's
   *  last admin, the oldest remaining member is promoted (enforced atomically by
   *  {@link leaveConversation} itself) and a second system message announces it. */
  async leave(conversationId: string, userId: string): Promise<void> {
    const membership = await getMembership(this.db, conversationId, userId);
    if (!membership) throw new NotFoundException('Conversation not found');

    const actor = await findUserById(this.db, userId);
    const result = await leaveConversation(this.db, conversationId, userId);
    this.realtime.removeConversationForUser(userId, conversationId);

    await this.postSystemMessage(conversationId, `${actor!.displayName} left`);
    await this.announcePromotionIfAny(conversationId, result.promotedUserId);
  }

  /** CHAT-018: "members list shows roles" AC. Available to any current member, not just admins. */
  async listMembers(conversationId: string, userId: string): Promise<MemberSummary[]> {
    const membership = await getMembership(this.db, conversationId, userId);
    if (!membership) throw new NotFoundException('Conversation not found');

    const rows = await listActiveMembers(this.db, conversationId);
    return Promise.all(
      rows.map(async (row) => ({
        userId: row.user.id,
        username: row.user.username,
        displayName: row.user.displayName,
        avatarUrl: await this.s3.getAvatarUrl(row.user.avatarKey),
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
      })),
    );
  }

  private async announcePromotionIfAny(
    conversationId: string,
    promotedUserId: string | null,
  ): Promise<void> {
    if (!promotedUserId) return;
    const promoted = await findUserById(this.db, promotedUserId);
    await this.postSystemMessage(conversationId, `${promoted!.displayName} is now an admin`);
  }

  /** Appends a `type: 'system'` message (`senderId: null`) and broadcasts it exactly like an
   *  ordinary message -- CHAT-018's "membership changes appear as system messages" AC, reusing
   *  CHAT-014's message pipeline rather than inventing a parallel one. */
  private async postSystemMessage(conversationId: string, body: string): Promise<void> {
    const row = await appendMessage(this.db, {
      conversationId,
      senderId: null,
      body,
      type: 'system',
    });
    const message = toMessage(row);
    await this.realtime.publishToConversation(
      conversationId,
      makeEnvelope('message.new', message, message.id),
    );
  }

  /** 404s for a non-member (never leaking that a group exists to someone outside it) and 403s for
   *  a member who just isn't an admin -- the "member-only access is a 404, but an authenticated
   *  member denied an admin action is a 403" distinction called out in this story's brief. */
  private async requireGroupAdmin(
    conversationId: string,
    userId: string,
  ): Promise<ConversationListRow> {
    const row = await this.requireGroup(conversationId, userId);
    if (row.role !== 'admin') throw new ForbiddenException('Only an admin can do this');
    return row;
  }

  /** 404s for a non-member (never leaking that a group exists to someone outside it) and 400s for
   *  a real, current member of a *direct* conversation trying a group-only action on it. */
  private async requireGroup(conversationId: string, userId: string): Promise<ConversationListRow> {
    const row = await findConversationForUser(this.db, conversationId, userId);
    if (!row) throw new NotFoundException('Conversation not found');
    if (row.type !== 'group') throw new BadRequestException('Not a group conversation');
    return row;
  }

  private async requireUsersExist(userIds: string[]) {
    const users = await Promise.all(userIds.map((id) => findUserById(this.db, id)));
    const missingIndex = users.findIndex((u) => !u);
    if (missingIndex >= 0) throw new NotFoundException('User not found');
    return users as NonNullable<(typeof users)[number]>[];
  }
}
