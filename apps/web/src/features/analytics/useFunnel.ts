import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * `FunnelReport` from `apps/api/src/modules/analytics/analytics.service.ts`.
 *
 * EVERY RATIO IS COMPUTED SERVER-SIDE. The client never divides one count by
 * another: the service already returns `conversionFromPrevious`,
 * `conversionFromStart` and `hireRate`, and recomputing them here would be a
 * second source of truth that could disagree with the audit-visible figures.
 *
 * `null` IS NOT ZERO ANYWHERE IN THIS SHAPE. It means the measurement could
 * not be taken — an empty denominator, or a stay that has not ended — and the
 * UI must render it as "—". Showing 0% would assert a result nobody measured.
 */
export interface FunnelStage {
  name: string;
  /** 1-based pipeline order; the axis the funnel is reported along. */
  position: number;
  isTerminal: boolean;
  /** Applications that were EVER in this stage. Drives the bar length. */
  reached: number;
  /** Applications sitting here right now. */
  currentlyHere: number;
  /** reached(this) / reached(previous). Null when the previous was never reached. */
  conversionFromPrevious: number | null;
  /** reached(this) / totalApplications. Null when there are no applications. */
  conversionFromStart: number | null;
  /** FR7.2. Null until an application has both entered AND left this stage. */
  averageTimeInStageHours: number | null;
}

/** FR7.3 — `ApplicationSource` in `schema.prisma`, lower-case by definition. */
export type FunnelSourceName = 'job_board' | 'referral' | 'career_site' | 'other';

export interface FunnelSource {
  source: FunnelSourceName;
  applications: number;
  hires: number;
  /** Null when the channel produced no applications — unknown, not zero. */
  hireRate: number | null;
}

export interface FunnelReport {
  range: { from: string | null; to: string | null };
  jobId: string | null;
  totalApplications: number;
  stages: FunnelStage[];
  /** FR7.2. Null when nobody in range has been hired. */
  timeToHire: { hiredCount: number; averageDays: number; medianDays: number } | null;
  /**
   * FR7.3. `recorded + notRecorded === totalApplications`, so the coverage of
   * the measurement is visible next to its result.
   */
  sourceOfHire: {
    recorded: number;
    notRecorded: number;
    bySource: FunnelSource[];
  };
}

export interface FunnelFilters {
  /** ISO date-time. Inclusive lower bound on `applied_at`. */
  from?: string;
  to?: string;
  /** FR7.2 — one requisition. Must be a v4 uuid; see `isUuidV4`. */
  jobId?: string;
}

export function useFunnel(filters: FunnelFilters) {
  return useQuery({
    queryKey: ['funnel', filters.from ?? null, filters.to ?? null, filters.jobId ?? null],
    queryFn: ({ signal }) =>
      api.get<FunnelReport>('/analytics/funnel', {
        query: { from: filters.from, to: filters.to, jobId: filters.jobId },
        signal,
      }),
    /*
     * Changing a filter keeps the previous report on screen while the next one
     * loads, so the page does not collapse to skeletons and back. The body
     * marks itself busy during that window instead.
     */
    placeholderData: keepPreviousData,
  });
}

/**
 * Is this id one the funnel's `jobId` filter will accept?
 *
 * `FunnelQueryDto` validates with `@IsUUID('4')`, which requires the version
 * nibble to be `4` and the variant nibble to be 8/9/a/b. The seeded job's id is
 * `00000000-0000-0000-0000-000000000010` — readable, but not a v4 — so the API
 * answers 400 for it while `GET /v1/jobs/:id` accepts it happily (that route
 * uses an unversioned `ParseUUIDPipe`).
 *
 * The job picker therefore omits ids that would be rejected, rather than
 * offering a choice whose only outcome is a validation error.
 */
export function isUuidV4(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/**
 * A ratio as a percentage — or "—" when it was never measured.
 *
 * THE ONE FORMATTING RULE THAT MATTERS ON THIS SCREEN. `null` and `0` are
 * different findings: 0% means candidates reached the previous stage and none
 * progressed; "—" means the previous stage was never reached, so the rate has
 * no denominator. Collapsing them would invent a conversion failure.
 */
export function formatRatio(value: number | null): string {
  if (value === null) return '—';
  const percent = value * 100;
  // Whole numbers read better unadorned; anything else keeps one decimal.
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

/** Hours as something a recruiter reads, or "—" when no stay has ended. */
export function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 24) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

/** `career_site` is a stored constant, not a label. */
export function formatSource(source: string): string {
  return source
    .split('_')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}
