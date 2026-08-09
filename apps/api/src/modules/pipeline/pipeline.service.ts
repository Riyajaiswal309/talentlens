import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Application, PipelineStage, Prisma, StageHistory } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';

/**
 * Audit action for a terminal decision (Handoff §I).
 *
 * Keyed by stage NAME rather than by the `is_terminal` flag alone, because
 * the flag says a stage ends the process while these two strings say WHICH
 * ending it was. The PRD §14.1 defaults seed `is_terminal` for exactly these
 * two, so every terminal stage that exists today is covered; a custom
 * terminal stage added later would be recorded as a stage change only, which
 * is accurate rather than mislabelled.
 */
const TERMINAL_AUDIT_ACTIONS: Record<string, string> = {
  Hired: 'application.hired',
  Rejected: 'application.rejected',
};

export interface StageChangeResult {
  application: Application;
  /** The stage moved away from. Null only if the row predates any history. */
  fromStage: string;
  toStage: PipelineStage;
  history: StageHistory;
  /** Handoff §I — emitted in addition to `application.stage_changed`. */
  terminalAction?: string;
}

/** Returned when the application is already in the requested stage. */
export interface StageUnchangedResult {
  application: Application;
  unchanged: true;
}

@Injectable()
export class PipelineService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR5.1 / FR5.4 — move one application to another stage of its own job.
   *
   * TENANCY is enforced here, not by a guard. JobAssignmentGuard keys off a
   * job id in the route and this route carries an application id, so there
   * is nothing for it to inspect; `applications` has no company_id of its own
   * (PRD §17.2), so the scope is reached through the job. Refusal is 404, not
   * 403 — a 403 would confirm the application exists in another tenant
   * (BR-06, PRD §26).
   *
   * BR-01 is satisfied structurally: `stage_history.changed_by` is NOT NULL
   * and is filled from the authenticated principal, so no path exists that
   * moves an application into Rejected without a human actor on record.
   */
  async changeStage(
    user: AuthenticatedUser,
    applicationId: string,
    toStageName: string,
  ): Promise<StageChangeResult | StageUnchangedResult> {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId, job: { companyId: user.companyId } },
      include: { job: { include: { stages: { orderBy: { position: 'asc' } } } } },
    });

    if (!application) throw new NotFoundException();

    /*
     * The target must belong to THIS job's pipeline. Stages are per-job
     * (decision B2), so a name valid for one requisition may be meaningless
     * for another — validating against a global list would let a candidate be
     * moved into a stage their job does not have.
     */
    const target = application.job.stages.find((stage) => stage.name === toStageName);
    if (!target) {
      const available = application.job.stages.map((stage) => stage.name).join(', ');
      throw new BadRequestException(
        `'${toStageName}' is not a stage on this job. Available stages: ${available}`,
      );
    }

    /*
     * Already there. Dragging a card back onto its own column is not a
     * transition, so it writes no stage_history row and no audit record —
     * FR5.4 records transitions, and inventing one here would overstate the
     * history. Approved decision: any stage on the pipeline is a legal
     * target, so this is a no-op rather than an error.
     */
    if (application.currentStage === target.name) {
      return { application, unchanged: true };
    }

    const fromStage = application.currentStage;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.application.update({
        where: { id: application.id },
        data: { currentStage: target.name },
      });

      /*
       * FR5.4 — "Every stage transition is recorded with actor and
       * timestamp." Written in the SAME transaction as the move, so the
       * board and its history can never disagree about where a candidate is.
       */
      const history = await tx.stageHistory.create({
        data: {
          applicationId: application.id,
          fromStage,
          toStage: target.name,
          changedBy: user.id,
        },
      });

      return {
        application: updated,
        fromStage,
        toStage: target,
        history,
        terminalAction: target.isTerminal ? TERMINAL_AUDIT_ACTIONS[target.name] : undefined,
      };
    });
  }

  /**
   * The candidate and job behind an application, for FR2.3 notification.
   *
   * Already authorised by the caller — the move it follows has happened — so
   * this is a plain read with no scoping of its own.
   */
  findForNotification(applicationId: string) {
    return this.prisma.application.findUnique({
      where: { id: applicationId },
      select: {
        candidate: { select: { email: true, fullName: true } },
        job: { select: { title: true } },
      },
    });
  }

  /**
   * FR5.2 — move many applications to one stage.
   *
   * Each candidate is processed through `changeStage` above, so the rules are
   * not reimplemented here: tenancy, stage validation and the no-op case
   * behave identically to a single move, and a future change to those rules
   * cannot make the bulk path diverge.
   *
   * PARTIAL RESULTS BY DESIGN (Phase 1 RC-10 lists "Partial failure" as a
   * required state). Each candidate moves in its own transaction, so one
   * failure neither rolls back the others nor aborts the batch. A recruiter
   * clearing a shortlist should not lose forty successful moves because the
   * forty-first was already deleted.
   *
   * Failure reasons are deliberately identical for "not yours" and "does not
   * exist" — the same non-disclosure rule as the single endpoint (BR-06).
   */
  async changeStageBulk(
    user: AuthenticatedUser,
    applicationIds: string[],
    toStageName: string,
  ): Promise<BulkStageResult> {
    const result: BulkStageResult = { moved: [], unchanged: [], failed: [] };

    // The same id twice is one candidate, not two moves. Deduplicated while
    // preserving request order so the response reads predictably.
    const ids = [...new Set(applicationIds)];

    for (const id of ids) {
      try {
        const outcome = await this.changeStage(user, id, toStageName);

        if ('unchanged' in outcome) {
          result.unchanged.push(id);
        } else {
          result.moved.push(outcome);
        }
      } catch (error) {
        result.failed.push({ id, reason: reasonFor(error) });
      }
    }

    return result;
  }
}

/**
 * Turn a per-candidate failure into text a recruiter can act on.
 *
 * Only the two expected refusals are described. Anything else is reported
 * generically rather than leaking an internal message into a 200 response —
 * an unexpected error is not a business outcome.
 */
function reasonFor(error: unknown): string {
  if (error instanceof NotFoundException) return 'Not found';
  if (error instanceof BadRequestException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null) {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return error.message;
  }
  return 'Could not be moved';
}

export interface BulkStageResult {
  /** Moves that happened, in request order. Drives the per-candidate audit. */
  moved: StageChangeResult[];
  /** Already in the target stage — nothing to record, but not a failure. */
  unchanged: string[];
  failed: { id: string; reason: string }[];
}

/** Audit snapshots for a stage change (PRD §17.3, BR-03). */
export function toStageAuditState(result: StageChangeResult): {
  before: Prisma.InputJsonValue;
  after: Prisma.InputJsonValue;
} {
  return {
    before: { applicationId: result.application.id, currentStage: result.fromStage },
    after: {
      applicationId: result.application.id,
      currentStage: result.application.currentStage,
      isTerminal: result.toStage.isTerminal,
      changedBy: result.history.changedBy,
      changedAt: result.history.changedAt.toISOString(),
    },
  };
}
