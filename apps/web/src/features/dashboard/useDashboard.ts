import { useFunnel } from '../analytics/useFunnel';
import { useJobs, type JobResponse } from '../jobs/useJobs';

/**
 * RC-01's data (Table 5.1 — "stat tiles, active-jobs table, funnel snapshot").
 *
 * COMPOSED FROM TWO EXISTING QUERIES, NOT A NEW ENDPOINT. There is no dashboard
 * API; `GET /v1/jobs` and `GET /v1/analytics/funnel` already carry everything
 * this screen can honestly report, and reusing their hooks means the dashboard
 * shares their cache — opening RC-02 or RC-12 afterwards costs no extra
 * request, and a stage change invalidates all three together.
 *
 * WHAT IS MISSING AND WHY IT STAYS MISSING. Table 5.1 also lists an
 * "awaiting review" count. That is FR3.2's parse-review queue, and its only
 * endpoint is `GET /v1/jobs/:id/parse-review` — per job, with no cross-job
 * aggregate. Summing it would mean one request per requisition and would still
 * report zero, because no parser runs in this phase. The tile therefore states
 * that the measurement is unavailable rather than showing a zero that reads
 * like a finding.
 */
export function useDashboard() {
  /*
   * The first page only. §23.1 makes every list cursor-paginated with no total,
   * so these counts describe the jobs actually loaded — `hasMore` below is what
   * keeps that honest on screen.
   */
  const jobs = useJobs({}, undefined);
  const funnel = useFunnel({});

  const all: JobResponse[] = jobs.data?.data ?? [];

  return {
    jobs,
    funnel,
    all,
    /** FR1.1's live requisitions — the ones actually accepting applications. */
    published: all.filter((job) => job.status === 'PUBLISHED'),
    drafts: all.filter((job) => job.status === 'DRAFT'),
    closed: all.filter((job) => job.status === 'CLOSED'),
    /** True when more jobs exist beyond the page these counts were taken from. */
    hasMore: Boolean(jobs.data?.nextCursor),
    isPending: jobs.isPending || funnel.isPending,
    isError: jobs.isError || funnel.isError,
    error: jobs.error ?? funnel.error,
    refetch: () => {
      void jobs.refetch();
      void funnel.refetch();
    },
  };
}
