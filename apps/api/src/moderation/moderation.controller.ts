import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  auditQuerySchema,
  liftRestrictionSchema,
  reportsQuerySchema,
  reportUserSchema,
  resolveReportSchema,
  type AuditPage,
  type LiftRestrictionInput,
  type ReportDetail,
  type ReportSummary,
  type ReportsPage,
  type ReportsQuery,
  type ReportUserInput,
  type ResolveReportInput,
} from '@videochat/shared';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ReportsService } from '../messages/reports.service.js';
import { MessageThrottlerGuard } from '../rate-limit/rate-limit.guards.js';
import { ModerationService } from './moderation.service.js';
import { ModeratorGuard } from './moderator.guard.js';

/** CHAT-077: report a person. Any signed-in user, from a chat they share with that person. */
@Controller('users')
@UseGuards(AccessTokenGuard)
export class UserReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post(':id/report')
  @HttpCode(204)
  @UseGuards(MessageThrottlerGuard)
  async report(
    @CurrentUserId() userId: string,
    @Param('id', UuidParamPipe) reportedUserId: string,
    @Body(new ZodValidationPipe(reportUserSchema)) body: ReportUserInput,
  ): Promise<void> {
    await this.reports.reportUser(userId, reportedUserId, body);
  }
}

/** CHAT-077: the moderation console. Moderators only; every action is audited. */
@Controller('moderation')
@UseGuards(AccessTokenGuard, ModeratorGuard)
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('reports')
  list(
    @Query(new ZodValidationPipe(reportsQuerySchema)) query: ReportsQuery,
  ): Promise<ReportsPage> {
    return this.moderation.listReports(query.status, query.cursor);
  }

  @Get('reports/:id')
  get(
    @CurrentUserId() moderatorId: string,
    @Param('id', UuidParamPipe) id: string,
  ): Promise<ReportDetail> {
    return this.moderation.getReport(moderatorId, id);
  }

  @Post('reports/:id/resolve')
  @HttpCode(200)
  resolve(
    @CurrentUserId() moderatorId: string,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(resolveReportSchema)) body: ResolveReportInput,
  ): Promise<ReportSummary> {
    return this.moderation.resolve(moderatorId, id, body);
  }

  @Post('users/:id/lift')
  @HttpCode(204)
  async lift(
    @CurrentUserId() moderatorId: string,
    @Param('id', UuidParamPipe) userId: string,
    @Body(new ZodValidationPipe(liftRestrictionSchema)) body: LiftRestrictionInput,
  ): Promise<void> {
    await this.moderation.lift(moderatorId, userId, body.note);
  }

  @Get('audit')
  audit(
    @Query(new ZodValidationPipe(auditQuerySchema)) query: z.infer<typeof auditQuerySchema>,
  ): Promise<AuditPage> {
    return this.moderation.audit(query.cursor, query.userId);
  }
}
