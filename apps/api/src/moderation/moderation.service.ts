import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  AuditAction,
  AuditPage,
  ContextMessage,
  ModerationAction,
  ReportDetail,
  ReportReason,
  ReportStatus,
  ReportSummary,
  ReportsPage,
  ResolveReportInput,
} from '@videochat/shared';
import { TokenStateService } from '../auth/token-state.service.js';
import type { Database } from '../db/client.js';
import { findMessage } from '../db/messages.js';
import {
  closeReport,
  countOpenReportsAbout,
  encodeCursor,
  findReport,
  findUsersByIds,
  insertAudit,
  listAudit,
  listReports,
  loadReportContext,
  restrictUser,
  toModerationUser,
} from '../db/moderation.js';
import { revokeAllForUser } from '../db/refresh-tokens.js';
import type { MessageReportRow, MessageRow, User } from '../db/schema.js';
import { DB } from '../infra/tokens.js';
import { MailService } from '../mail/mail.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * CHAT-077: the moderation console's backend. Moderators work a queue of reports; for each one
 * they see the reported content and at most `MODERATION.contextMessages` messages around it, and
 * can dismiss it, warn the person, suspend them for some days or ban them. Every action --
 * opening a report included -- is written to the audit log in the same transaction as its effect.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly tokenState: TokenStateService,
    private readonly realtime: RealtimeService,
    private readonly mail: MailService,
  ) {}

  async listReports(status: ReportStatus, cursor: string | undefined): Promise<ReportsPage> {
    const { rows, hasMore } = await listReports(this.db, status, cursor);
    return {
      reports: await this.summaries(rows),
      nextCursor: hasMore && rows.length ? encodeCursor(rows.at(-1)!) : null,
    };
  }

  /** Opening a report shows its content, so it's an audited action like any other. */
  async getReport(moderatorId: string, id: string): Promise<ReportDetail> {
    const row = await findReport(this.db, id);
    if (!row) throw new NotFoundException('Report not found');
    const [summary] = await this.summaries([row]);
    const message = row.messageId ? await findMessage(this.db, row.messageId) : undefined;
    const contextRows = message
      ? await loadReportContext(this.db, row.conversationId, message.seq)
      : [];
    const people = await findUsersByIds(
      this.db,
      contextRows.map((m) => m.senderId),
    );
    await insertAudit(this.db, {
      moderatorId,
      action: 'view_report' satisfies AuditAction,
      reportId: row.id,
      targetUserId: row.reportedUserId,
    });
    return {
      ...summary!,
      snapshot: row.messageId
        ? { text: row.bodySnapshot, fromReporter: row.snapshotFromReporter }
        : null,
      context: contextRows.map((m) => toContextMessage(m, people, row.messageId)),
    };
  }

  async resolve(
    moderatorId: string,
    id: string,
    input: ResolveReportInput,
  ): Promise<ReportSummary> {
    const report = await findReport(this.db, id);
    if (!report) throw new NotFoundException('Report not found');
    if (report.status !== 'open') throw new ConflictException('This report was already handled');
    const target = report.reportedUserId;
    if (input.action !== 'dismiss') {
      if (!target) throw new BadRequestException('The reported account no longer exists');
      if (target === moderatorId) {
        throw new BadRequestException('You can’t act on a report about yourself');
      }
    }
    const note = input.note?.length ? input.note : null;
    const until =
      input.action === 'suspend' ? new Date(Date.now() + input.days! * DAY_MS) : undefined;

    const closed = await this.db.transaction(async (tx) => {
      const row = await closeReport(tx, id, { moderatorId, action: input.action, note });
      if (!row) throw new ConflictException('This report was already handled');
      if (target && input.action === 'suspend') {
        await restrictUser(tx, target, { suspendedUntil: until! });
      }
      if (target && input.action === 'ban') await restrictUser(tx, target, { banned: true });
      await insertAudit(tx, {
        moderatorId,
        action: input.action,
        reportId: id,
        targetUserId: target,
        note,
        details: until ? { days: input.days, until: until.toISOString() } : null,
      });
      return row;
    });

    if (target && input.action !== 'dismiss') await this.afterAction(target, input.action, until);
    const [summary] = await this.summaries([closed]);
    return summary!;
  }

  /** Ends a suspension or ban early. */
  async lift(moderatorId: string, userId: string, note: string | undefined): Promise<void> {
    const [user] = (await findUsersByIds(this.db, [userId])).values();
    if (!user) throw new NotFoundException('User not found');
    if (!user.bannedAt && !(user.suspendedUntil && user.suspendedUntil.getTime() > Date.now())) {
      throw new BadRequestException('This account isn’t suspended or banned');
    }
    await this.db.transaction(async (tx) => {
      await restrictUser(tx, userId, { lift: true });
      await insertAudit(tx, {
        moderatorId,
        action: 'lift' satisfies AuditAction,
        targetUserId: userId,
        note: note?.length ? note : null,
      });
    });
    this.tokenState.invalidate(userId);
  }

  async audit(cursor: string | undefined, userId: string | undefined): Promise<AuditPage> {
    const { rows, hasMore } = await listAudit(this.db, cursor, userId);
    const people = await findUsersByIds(
      this.db,
      rows.flatMap((r) => [r.moderatorId, r.targetUserId]),
    );
    const person = (id: string | null) => {
      const u = id ? people.get(id) : undefined;
      return u ? toModerationUser(u) : null;
    };
    return {
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action as AuditAction,
        moderator: person(r.moderatorId),
        targetUser: person(r.targetUserId),
        reportId: r.reportId,
        note: r.note,
        details: r.details ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: hasMore && rows.length ? encodeCursor(rows.at(-1)!) : null,
    };
  }

  /** Suspensions and bans end every session now (refresh tokens, live sockets, and access
   *  tokens through the token-state check); the person is told by email. Best effort: the
   *  restriction itself is already saved. */
  private async afterAction(
    userId: string,
    action: Exclude<ModerationAction, 'dismiss'>,
    until: Date | undefined,
  ): Promise<void> {
    const [user] = (await findUsersByIds(this.db, [userId])).values();
    try {
      if (action !== 'warn') {
        await revokeAllForUser(this.db, userId);
        this.tokenState.invalidate(userId);
        await this.realtime.closeUserConnections(userId, 'account-restricted');
      }
      if (user && !user.deletedAt) {
        await this.mail.sendModerationNotice(
          user.email,
          action === 'suspend' ? { kind: 'suspend', until: until! } : { kind: action },
        );
      }
    } catch (err) {
      this.logger.warn(`Moderation follow-up failed for ${userId}: ${(err as Error).message}`);
    }
  }

  private async summaries(rows: MessageReportRow[]): Promise<ReportSummary[]> {
    const people = await findUsersByIds(
      this.db,
      rows.flatMap((r) => [r.reporterId, r.reportedUserId, r.resolvedBy]),
    );
    const counts = await countOpenReportsAbout(
      this.db,
      rows.map((r) => r.reportedUserId),
    );
    const person = (id: string | null) => {
      const u = id ? people.get(id) : undefined;
      return u ? toModerationUser(u) : null;
    };
    return rows.map((r) => ({
      id: r.id,
      kind: r.messageId ? 'message' : 'user',
      status: r.status as ReportStatus,
      reason: r.reason as ReportReason,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
      reporter: person(r.reporterId),
      reportedUser: person(r.reportedUserId),
      conversationId: r.conversationId,
      messageId: r.messageId,
      openReportsAboutUser: r.reportedUserId ? (counts.get(r.reportedUserId) ?? 0) : 0,
      resolution:
        r.status !== 'open' && r.resolution && r.resolvedAt
          ? {
              action: r.resolution as ModerationAction,
              note: r.resolutionNote,
              by: person(r.resolvedBy),
              at: r.resolvedAt.toISOString(),
            }
          : null,
    }));
  }
}

function toContextMessage(
  m: MessageRow,
  people: Map<string, User>,
  reportedId: string | null,
): ContextMessage {
  const deleted = m.deletedAt !== null;
  const sender = m.senderId ? people.get(m.senderId) : undefined;
  return {
    id: m.id,
    seq: m.seq,
    senderId: m.senderId,
    senderName: sender ? sender.displayName : null,
    type: m.type,
    // System and call entries have no user text worth showing; deleted messages have none left.
    text: deleted || m.type === 'call' ? null : m.body,
    attachmentName: !deleted && m.meta?.attachment ? m.meta.attachment.filename : null,
    encrypted: !!m.meta?.e2ee,
    deleted,
    createdAt: m.createdAt.toISOString(),
    reported: m.id === reportedId,
  };
}
