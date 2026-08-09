import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { BulkChangeStageDto } from './dto/bulk-change-stage.dto';
import { ChangeStageDto } from './dto/change-stage.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { PipelineService, toStageAuditState } from './pipeline.service';

/** Phase 1 RC-09 — the card settles and column counts update from this. */
interface StageChangeResponse {
  id: string;
  currentStage: string;
  previousStage: string | null;
  isTerminal: boolean;
  changedAt: string;
}

/** Phase 1 RC-10 — the bulk panel reports what happened to each selection. */
interface BulkStageResponse {
  succeeded: string[];
  failed: { id: string; reason: string }[];
}

@Controller('applications')
export class PipelineController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * PATCH /v1/applications/bulk/stage — Recruiter, Admin
   * (Handoff §B row 16, FR5.2, Phase 1 RC-10).
   *
   * DECLARED FIRST ON PURPOSE. Nest matches routes in declaration order, and
   * `bulk/stage` also fits the `:id/stage` pattern below with id='bulk'. If
   * that one were declared first, ParseUUIDPipe would reject every bulk
   * request as a malformed id.
   *
   * Always 200, including when every item failed: the request itself was
   * understood and answered, and the outcome per candidate is the payload.
   * Handoff §I audits this "per candidate", so the records are emitted one
   * per successful move rather than one for the batch.
   */
  @Patch('bulk/stage')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @Audit({ action: 'application.stage_changed', resourceType: 'application' })
  @HttpCode(HttpStatus.OK)
  async changeStageBulk(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkChangeStageDto,
    @Req() req: RequestContext,
  ): Promise<BulkStageResponse> {
    const result = await this.pipeline.changeStageBulk(user, dto.applicationIds, dto.toStage);

    /*
     * There is no single resource this request is "about", so the declared
     * record is suppressed and every event is emitted as a per-candidate
     * record instead. All of them are written by the interceptor before the
     * response is emitted (PRD §15.1 principle 4).
     */
    req.auditSuppressed = true;
    req.auditExtra = result.moved.flatMap((move) => {
      const state = toStageAuditState(move);
      const records = [
        {
          action: 'application.stage_changed',
          resourceId: move.application.id,
          before: state.before,
          after: state.after,
        },
      ];

      if (move.terminalAction) {
        records.push({
          action: move.terminalAction,
          resourceId: move.application.id,
          before: { currentStage: move.fromStage },
          after: { currentStage: move.application.currentStage },
        });
      }

      return records;
    });

    return {
      /*
       * A candidate already in the target stage counts as succeeded: the
       * caller asked for an end state and it holds. It produced no history
       * row and no audit record, because nothing moved.
       */
      succeeded: [...result.moved.map((move) => move.application.id), ...result.unchanged],
      failed: result.failed,
    };
  }

  /**
   * PATCH /v1/applications/:id/stage — Recruiter, Admin
   * (PRD §23.2, Handoff §B row 15, FR5.1 / FR5.4).
   *
   * HIRING MANAGER IS EXCLUDED, per PRD §24.2 Table 24.1: "Move pipeline
   * stage — Recruiter ✓, Hiring Manager —". An HM reviews and scores; they
   * do not advance or reject candidates.
   *
   * No `confirmed` field: BR-01's enforcement point is that the endpoint
   * requires an authenticated human actor, which it does. The terminal-stage
   * confirmation dialog (RC-09) is a frontend concern.
   */
  @Patch(':id/stage')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @Audit({ action: 'application.stage_changed', resourceType: 'application' })
  async changeStage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeStageDto,
    @Req() req: RequestContext,
  ): Promise<StageChangeResponse> {
    const result = await this.pipeline.changeStage(user, id, dto.toStage);

    if ('unchanged' in result) {
      // Nothing moved, so there is no transition to record (FR5.4) and no
      // event to audit (PRD §17.3).
      req.auditSuppressed = true;

      return {
        id: result.application.id,
        currentStage: result.application.currentStage,
        previousStage: null,
        isTerminal: false,
        changedAt: result.application.updatedAt.toISOString(),
      };
    }

    req.auditState = toStageAuditState(result);

    /*
     * Handoff §I records a terminal decision as its own event on top of the
     * transition, so a hire or a rejection is findable in the trail without
     * having to interpret every stage_changed row.
     */
    if (result.terminalAction) {
      req.auditExtra = [
        {
          action: result.terminalAction,
          before: { currentStage: result.fromStage },
          after: { currentStage: result.application.currentStage },
        },
      ];
    }

    /*
     * FR2.3 — status-change notification. Only on a real transition: the
     * no-op branch above returns before this, so a recruiter dragging a card
     * onto its own column does not email the candidate.
     */
    await this.notifyCandidate(
      result.application.id,
      result.application.currentStage,
      result.toStage.isTerminal,
    ).catch(() => undefined);

    return {
      id: result.application.id,
      currentStage: result.application.currentStage,
      previousStage: result.fromStage,
      isTerminal: result.toStage.isTerminal,
      changedAt: result.history.changedAt.toISOString(),
    };
  }

  /** Resolve the candidate and tell them (FR2.3). Never throws. */
  private async notifyCandidate(
    applicationId: string,
    toStage: string,
    isTerminal: boolean,
  ): Promise<void> {
    const application = await this.pipeline.findForNotification(applicationId);
    if (!application) return;

    await this.notifications.applicationStatusChanged({
      email: application.candidate.email,
      candidateName: application.candidate.fullName,
      jobTitle: application.job.title,
      toStage,
      isTerminal,
    });
  }
}
