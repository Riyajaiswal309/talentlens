import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationSource } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import type { FunnelQueryDto } from './dto/funnel-query.dto';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** PRD §14.1 seeds this name for the successful terminal stage. */
const HIRED_STAGE = 'Hired';

export interface FunnelStage {
  name: string;
  position: number;
  isTerminal: boolean;
  /** Applications that were ever in this stage. */
  reached: number;
  /** Applications sitting here right now. */
  currentlyHere: number;
  /** reached(this) / reached(previous). Null on the first stage. */
  conversionFromPrevious: number | null;
  /** reached(this) / total applications in range. */
  conversionFromStart: number | null;
  /** FR7.2. Null when no application has both entered and left this stage. */
  averageTimeInStageHours: number | null;
}

/** FR7.3 — one channel's contribution. */
export interface FunnelSource {
  source: ApplicationSource;
  applications: number;
  hires: number;
  /** hires / applications. Null when the channel produced no applications. */
  hireRate: number | null;
}

/**
 * FR7.3 — source of hire.
 *
 * `recorded` + `notRecorded` always equals `totalApplications`, so a reader
 * can see the coverage of the measurement at the same time as its result.
 */
export interface FunnelSourceOfHire {
  recorded: number;
  notRecorded: number;
  bySource: FunnelSource[];
}

export interface FunnelReport {
  range: { from: string | null; to: string | null };
  jobId: string | null;
  totalApplications: number;
  stages: FunnelStage[];
  /** FR7.2. Null when nobody in range has been hired. */
  timeToHire: { hiredCount: number; averageDays: number; medianDays: number } | null;
  /** FR7.3. Always present; `bySource` lists every value, including zeros. */
  sourceOfHire: FunnelSourceOfHire;
}

/**
 * FR7.1 and FR7.2 — the hiring funnel (PRD §23.2, Phase 1 RC-12).
 *
 * EVERY NUMBER COMES FROM `stage_history` AND `applications`. Phase 1 line
 * 1238 binds `stage_history` to RC-12, and FR5.4 makes it append-only and
 * written on every transition — so it is a complete record of movement, and
 * nothing here needs a counter that could drift from it.
 *
 * FR7.3 (source-of-hire) IS NOT REPORTED and no field for it appears in the
 * response. No document defines a source column, a capture point on the
 * application form, a vocabulary of source values or an attribution rule, and
 * `applications` has nowhere to record one. Emitting a zero or a null for it
 * would state a measurement that was never taken. It is recorded as an
 * outstanding gap in docs/PRD-AMENDMENTS.md instead.
 *
 * Aggregation happens in TypeScript over the fetched rows rather than in SQL.
 * At the scale this project targets a dashboard query is small, and the
 * walk below is verifiable by reading it — which matters more here than the
 * speed of an aggregate that would be considerably harder to check.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async funnel(user: AuthenticatedUser, query: FunnelQueryDto): Promise<FunnelReport> {
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;

    if (from && to && from > to) {
      throw new BadRequestException('from must not be after to');
    }

    /*
     * TENANCY. Every read below is filtered through `job.companyId`, so the
     * funnel can only ever aggregate this caller's own tenant. A `jobId` that
     * belongs to another company is refused as 404 rather than 403, and
     * returning an empty funnel instead would leak the same fact more quietly
     * — it would distinguish "no such job" from "not yours" by the shape of
     * the answer (BR-06, PRD §26).
     */
    if (query.jobId) {
      const job = await this.prisma.job.findFirst({
        where: { id: query.jobId, companyId: user.companyId },
        select: { id: true },
      });
      if (!job) throw new NotFoundException();
    }

    const stages = await this.stageOrder(user.companyId, query.jobId);

    const appliedAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };

    const applications = await this.prisma.application.findMany({
      where: {
        job: {
          companyId: user.companyId,
          ...(query.jobId ? { id: query.jobId } : {}),
        },
        ...(from || to ? { appliedAt } : {}),
      },
      select: {
        id: true,
        currentStage: true,
        appliedAt: true,
        source: true,
        stageHistory: {
          select: { fromStage: true, toStage: true, changedAt: true },
          orderBy: { changedAt: 'asc' },
        },
      },
    });

    const total = applications.length;

    /*
     * FR7.3. Every value is seeded at zero so a channel that produced nothing
     * is visibly barren rather than absent — the same treatment a stage nobody
     * reached already gets.
     *
     * NULL is counted in `notRecorded` alone and never enters these maps.
     * Folding it into `other` would let a data-coverage problem read as a
     * finding about a channel (D30).
     */
    const applicationsBySource = new Map<ApplicationSource, number>();
    const hiresBySource = new Map<ApplicationSource, number>();
    for (const value of Object.values(ApplicationSource)) {
      applicationsBySource.set(value, 0);
      hiresBySource.set(value, 0);
    }
    let notRecorded = 0;

    // name -> applications that were ever there / are there now
    const reached = new Map<string, number>();
    const currently = new Map<string, number>();
    // name -> completed stay durations, in ms
    const durations = new Map<string, number[]>();
    const timeToHire: number[] = [];

    for (const application of applications) {
      const visited = new Set<string>();

      // FR7.3 — the denominator. NULL never enters `bySource` (D30).
      if (application.source === null) {
        notRecorded += 1;
      } else {
        applicationsBySource.set(
          application.source,
          (applicationsBySource.get(application.source) ?? 0) + 1,
        );
      }
      /*
       * Counted once per application, not once per transition into Hired.
       * `timeToHire` pushes a duration per transition because it averages
       * durations; `hires` is the numerator of a rate against `applications`,
       * so an application that somehow re-entered Hired must not make
       * `hireRate` exceed 1. The rule for what counts as a hire is identical —
       * a transition into the Hired stage — so for the ordinary case of one
       * hire per application the two figures agree exactly.
       */
      let everHired = false;

      /*
       * An application's first stage has no `stage_history` row — history is
       * written on transition, and creation is not one. Its opening stay
       * therefore starts at `applied_at`, and the stage it started in is
       * recoverable from the first transition's `from_stage`, or from
       * `current_stage` if it never moved.
       */
      const first = application.stageHistory[0];
      const initialStage = first
        ? (first.fromStage ?? application.currentStage)
        : application.currentStage;

      let stayStage = initialStage;
      let stayStart = application.appliedAt;
      visited.add(initialStage);

      for (const transition of application.stageHistory) {
        // The stay that just ended.
        const completed = transition.changedAt.getTime() - stayStart.getTime();
        push(durations, stayStage, completed);

        visited.add(transition.toStage);
        if (transition.fromStage) visited.add(transition.fromStage);

        if (transition.toStage === HIRED_STAGE) {
          timeToHire.push(transition.changedAt.getTime() - application.appliedAt.getTime());
          everHired = true;
        }

        stayStage = transition.toStage;
        stayStart = transition.changedAt;
      }

      /*
       * The final stay is deliberately NOT counted. It has not ended, so its
       * elapsed time is a lower bound rather than a duration — averaging it in
       * would drag every still-active stage's figure downward and make a
       * bottleneck look faster the longer candidates sit in it.
       */

      if (everHired && application.source !== null) {
        hiresBySource.set(application.source, (hiresBySource.get(application.source) ?? 0) + 1);
      }

      visited.add(application.currentStage);
      for (const name of visited) {
        reached.set(name, (reached.get(name) ?? 0) + 1);
      }
      currently.set(application.currentStage, (currently.get(application.currentStage) ?? 0) + 1);
    }

    const rows: FunnelStage[] = stages.map((stage, index) => {
      const count = reached.get(stage.name) ?? 0;
      const previous = index === 0 ? null : (reached.get(stages[index - 1]!.name) ?? 0);
      const stays = durations.get(stage.name) ?? [];

      return {
        name: stage.name,
        position: stage.position,
        isTerminal: stage.isTerminal,
        reached: count,
        currentlyHere: currently.get(stage.name) ?? 0,
        conversionFromPrevious:
          previous === null || previous === 0 ? null : round(count / previous, 4),
        conversionFromStart: total === 0 ? null : round(count / total, 4),
        averageTimeInStageHours: stays.length === 0 ? null : round(mean(stays) / HOUR_MS, 2),
      };
    });

    return {
      range: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
      jobId: query.jobId ?? null,
      totalApplications: total,
      stages: rows,
      sourceOfHire: {
        recorded: total - notRecorded,
        notRecorded,
        bySource: Object.values(ApplicationSource).map((source) => {
          const applicationCount = applicationsBySource.get(source) ?? 0;
          const hireCount = hiresBySource.get(source) ?? 0;
          return {
            source,
            applications: applicationCount,
            hires: hireCount,
            // Null, not 0, when the channel produced nothing — a rate over an
            // empty denominator is unknown rather than zero, the same rule
            // `conversionFromPrevious` follows.
            hireRate: applicationCount === 0 ? null : round(hireCount / applicationCount, 4),
          };
        }),
      },
      timeToHire:
        timeToHire.length === 0
          ? null
          : {
              hiredCount: timeToHire.length,
              averageDays: round(mean(timeToHire) / DAY_MS, 2),
              medianDays: round(median(timeToHire) / DAY_MS, 2),
            },
    };
  }

  /**
   * The stage axis the funnel is reported along.
   *
   * With a `jobId` this is simply that job's pipeline. Without one there is no
   * single pipeline to use — stages are per-job (decision B2) — so the axis is
   * the union of the tenant's stage names ordered by the lowest position any
   * job gives them, with the name as a tie-break so the ordering is total and
   * the response is stable between calls. In practice every job is seeded with
   * the same six PRD §14.1 defaults and the union is those six.
   */
  private async stageOrder(companyId: string, jobId?: string) {
    const stages = await this.prisma.pipelineStage.findMany({
      where: { job: { companyId, ...(jobId ? { id: jobId } : {}) } },
      select: { name: true, position: true, isTerminal: true },
    });

    const byName = new Map<string, { name: string; position: number; isTerminal: boolean }>();
    for (const stage of stages) {
      const existing = byName.get(stage.name);
      if (!existing || stage.position < existing.position) {
        byName.set(stage.name, { ...stage });
      }
      // A stage terminal on any job is reported as terminal: BR-01 treats it
      // as an ending wherever it appears, and the funnel should not imply
      // candidates flow onward out of it.
      if (existing?.isTerminal || stage.isTerminal) {
        byName.get(stage.name)!.isTerminal = true;
      }
    }

    return [...byName.values()].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
  }
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
