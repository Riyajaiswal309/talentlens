import { useId, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton, SkeletonTable } from '../../components/Skeleton';
import { useJobs } from '../jobs/useJobs';
import { FunnelBars } from './FunnelBars';
import {
  formatHours,
  formatRatio,
  formatSource,
  isUuidV4,
  useFunnel,
  type FunnelReport,
} from './useFunnel';

/**
 * RC-12 — Analytics, the hiring funnel (Table 5.1; FR7.1–FR7.3;
 * `GET /v1/analytics/funnel`).
 *
 * "EXPORT VIEW" IS NOT BUILT. Table 5.1 lists it as a secondary action, but no
 * endpoint produces it — the only export in the API is `/v1/audit-logs/export`,
 * which is Administrator-only and unrelated. A button that assembled a CSV in
 * the browser would be a different artefact from the one §23.2 will eventually
 * define, so the control is shown as unavailable instead.
 *
 * Every ratio on this screen comes from the API. Nothing is derived here except
 * bar widths, which are a rendering of `reached` rather than a new measurement.
 */
export function FunnelPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [jobId, setJobId] = useState('');

  const filters = {
    // A date input yields `YYYY-MM-DD`; the API wants ISO 8601. `from` opens the
    // day and `to` closes it, so a single-day range includes that whole day.
    ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
    ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
    ...(jobId ? { jobId } : {}),
  };
  const filtersActive = Boolean(from || to || jobId);

  const funnel = useFunnel(filters);

  /*
   * The job picker. Only jobs whose id the funnel will accept are offered —
   * `FunnelQueryDto` validates `@IsUUID('4')` and the seeded job's readable id
   * is not a v4, so listing it would offer a choice that can only 400.
   */
  const jobs = useJobs({}, undefined);
  const selectableJobs = (jobs.data?.data ?? []).filter((job) => isUuidV4(job.id));
  const omittedJobCount = (jobs.data?.data ?? []).length - selectableJobs.length;

  const fromId = useId();
  const toId = useId();
  const jobSelectId = useId();

  function clearFilters() {
    setFrom('');
    setTo('');
    setJobId('');
  }

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-neutral-500">RC-12</p>
          <h1 className="text-2xl font-semibold text-neutral-900">Analytics</h1>
          <p className="mt-1 text-sm text-neutral-700">
            Conversion through your hiring pipeline, for your company only.
          </p>
        </div>

        {/* Declared unavailable rather than faked — see the file header. */}
        <div className="text-right">
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="No export endpoint exists yet"
            className="h-10 cursor-not-allowed rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-300"
          >
            Export view
          </button>
          <p className="mt-1 text-xs text-neutral-500">Export is not available yet.</p>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-end gap-4 rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <div>
          <label htmlFor={fromId} className="mb-1 block text-sm font-semibold text-neutral-900">
            Applied from
          </label>
          <input
            id={fromId}
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="h-10 rounded-sm border border-neutral-300 px-3 text-sm text-neutral-900"
          />
        </div>
        <div>
          <label htmlFor={toId} className="mb-1 block text-sm font-semibold text-neutral-900">
            Applied to
          </label>
          <input
            id={toId}
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="h-10 rounded-sm border border-neutral-300 px-3 text-sm text-neutral-900"
          />
        </div>
        <div>
          <label
            htmlFor={jobSelectId}
            className="mb-1 block text-sm font-semibold text-neutral-900"
          >
            Job
          </label>
          <select
            id={jobSelectId}
            value={jobId}
            onChange={(event) => setJobId(event.target.value)}
            className="h-10 w-56 rounded-sm border border-neutral-300 bg-neutral-0 px-3 text-sm text-neutral-900"
          >
            <option value="">All jobs</option>
            {selectableJobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
              </option>
            ))}
          </select>
        </div>

        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
          >
            Clear filters
          </button>
        )}

        {omittedJobCount > 0 && (
          // Said out loud: a job silently missing from a filter is worse than a
          // job explained. See `isUuidV4`.
          <p className="w-full text-xs text-neutral-500">
            {omittedJobCount} older {omittedJobCount === 1 ? 'job is' : 'jobs are'} not filterable —
            the analytics endpoint only accepts version-4 job identifiers.
          </p>
        )}
      </div>

      <FunnelBody query={funnel} filtersActive={filtersActive} onClearFilters={clearFilters} />
    </div>
  );
}

function FunnelBody({
  query,
  filtersActive,
  onClearFilters,
}: {
  query: ReturnType<typeof useFunnel>;
  filtersActive: boolean;
  onClearFilters: () => void;
}) {
  if (query.isPending) {
    return (
      <LoadingState label="Loading the funnel…">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-[76px]" />
            <Skeleton className="h-[76px]" />
            <Skeleton className="h-[76px]" />
          </div>
          <Skeleton className="h-[240px]" />
          <SkeletonTable rows={6} columns={5} />
        </div>
      </LoadingState>
    );
  }

  if (query.isError) {
    /*
     * The server's own sentence. A bad range answers 400 with "from must not be
     * after to", which names the fix — exactly what §10.5 asks of error text.
     */
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const report = query.data;
  if (!report) return null;

  if (report.totalApplications === 0) {
    // Two empties, as on RC-02: a range that matched nothing needs the range
    // cleared; a company with no applications needs candidates.
    return filtersActive ? (
      <EmptyState
        variant="filtered"
        title="No applications in this range"
        description="No application in your company was received within the dates or job you selected."
        action={
          <button
            type="button"
            onClick={onClearFilters}
            className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
          >
            Clear filters
          </button>
        }
      />
    ) : (
      <EmptyState
        title="No applications yet"
        description="Once candidates apply, their progress through your pipeline appears here."
      />
    );
  }

  return (
    <div
      aria-busy={query.isFetching}
      className={query.isFetching ? 'space-y-4 opacity-60' : 'space-y-4'}
    >
      <StatTiles report={report} />
      <SingleStageNotice report={report} />
      <FunnelBars stages={report.stages} totalApplications={report.totalApplications} />
      <ConversionTable report={report} />
      <div className="grid gap-4 lg:grid-cols-2">
        <TimeToHirePanel report={report} />
        <SourceOfHirePanel report={report} />
      </div>
    </div>
  );
}

function StatTiles({ report }: { report: FunnelReport }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      <Tile label="Applications" value={String(report.totalApplications)} />
      <Tile
        label="Hired"
        // Null time-to-hire means nobody was hired — reported as 0 because that
        // IS the count, unlike a ratio with no denominator.
        value={String(report.timeToHire?.hiredCount ?? 0)}
      />
      <Tile
        label="Source recorded"
        value={`${report.sourceOfHire.recorded} of ${report.totalApplications}`}
        hint={
          report.sourceOfHire.notRecorded > 0
            ? `${report.sourceOfHire.notRecorded} not recorded`
            : undefined
        }
      />
    </dl>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
      <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-neutral-900">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

/**
 * Table 5.1 names "single stage" as a state of its own.
 *
 * A funnel where only the first stage has volume looks broken unless it says
 * why. This makes the shape deliberate: the data is complete, the pipeline
 * simply has not been used yet.
 */
function SingleStageNotice({ report }: { report: FunnelReport }) {
  const withVolume = report.stages.filter((stage) => stage.reached > 0);
  if (withVolume.length !== 1) return null;

  return (
    <p className="rounded-sm border border-info-700 bg-neutral-0 px-3 py-2 text-sm text-info-700">
      Every application is still in {withVolume[0]!.name}. Conversion and time-in-stage figures
      appear once candidates move to a later stage.
    </p>
  );
}

function ConversionTable({ report }: { report: FunnelReport }) {
  return (
    <section className="rounded-md border border-neutral-300 bg-neutral-0">
      <div className="border-b border-neutral-300 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Stage conversion</h2>
        <p className="mt-1 text-sm text-neutral-700">
          {/* The rule spelled out, because a dash is otherwise ambiguous. */}A dash means the
          figure could not be measured — not that it is zero.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Conversion and time in stage for each pipeline stage
          </caption>
          <thead>
            <tr className="border-b border-neutral-300 bg-neutral-100 text-left">
              <Th>Stage</Th>
              <Th numeric>Reached</Th>
              <Th numeric>Here now</Th>
              <Th numeric>From previous</Th>
              <Th numeric>From start</Th>
              <Th numeric>Avg. time in stage</Th>
            </tr>
          </thead>
          <tbody>
            {report.stages.map((stage) => (
              <tr key={stage.name} className="border-b border-neutral-300 last:border-0">
                <td className="px-4 py-3 font-semibold text-neutral-900">
                  {stage.position}. {stage.name}
                  {stage.isTerminal && (
                    <span className="ml-2 text-xs font-normal text-neutral-500">Terminal</span>
                  )}
                </td>
                <Td>{stage.reached}</Td>
                <Td>{stage.currentlyHere}</Td>
                {/* formatRatio is the single place null becomes "—". */}
                <Td muted={stage.conversionFromPrevious === null}>
                  {formatRatio(stage.conversionFromPrevious)}
                </Td>
                <Td muted={stage.conversionFromStart === null}>
                  {formatRatio(stage.conversionFromStart)}
                </Td>
                <Td muted={stage.averageTimeInStageHours === null}>
                  {formatHours(stage.averageTimeInStageHours)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({ children, numeric = false }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 ${
        numeric ? 'text-right' : ''
      }`}
    >
      {children}
    </th>
  );
}

function Td({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <td
      className={`px-4 py-3 text-right font-mono ${muted ? 'text-neutral-500' : 'text-neutral-900'}`}
    >
      {children}
    </td>
  );
}

/** FR7.2 — time to hire, with an honest empty reading. */
function TimeToHirePanel({ report }: { report: FunnelReport }) {
  return (
    <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
      <h2 className="text-base font-semibold text-neutral-900">Time to hire</h2>

      {report.timeToHire === null ? (
        <p className="mt-2 text-sm text-neutral-700">
          {/* Null means no application in range reached the Hired stage. Saying
              so beats printing a zero that would read as an instant hire. */}
          No hires in this range yet, so there is nothing to average.
        </p>
      ) : (
        <dl className="mt-3 grid gap-4 sm:grid-cols-3">
          <Tile label="Hired" value={String(report.timeToHire.hiredCount)} />
          <Tile label="Average" value={`${report.timeToHire.averageDays} d`} />
          <Tile label="Median" value={`${report.timeToHire.medianDays} d`} />
        </dl>
      )}
    </section>
  );
}

/** FR7.3 — source of hire, including the channels that produced nothing. */
function SourceOfHirePanel({ report }: { report: FunnelReport }) {
  const { recorded, notRecorded, bySource } = report.sourceOfHire;

  return (
    <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
      <h2 className="text-base font-semibold text-neutral-900">Source of hire</h2>
      <p className="mt-1 text-sm text-neutral-700">
        {recorded} of {report.totalApplications} recorded a source
        {notRecorded > 0 ? `, ${notRecorded} did not` : ''}.
      </p>

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left">
            <Th>Channel</Th>
            <Th numeric>Applications</Th>
            <Th numeric>Hires</Th>
            <Th numeric>Hire rate</Th>
          </tr>
        </thead>
        <tbody>
          {bySource.map((entry) => (
            <tr key={entry.source} className="border-b border-neutral-300 last:border-0">
              <td className="px-4 py-2 text-neutral-900">{formatSource(entry.source)}</td>
              <Td>{entry.applications}</Td>
              <Td>{entry.hires}</Td>
              {/* Null here means the channel had no applications at all. */}
              <Td muted={entry.hireRate === null}>{formatRatio(entry.hireRate)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
