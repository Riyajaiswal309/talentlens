import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton, SkeletonText } from '../../components/Skeleton';
import { useBreadcrumbLabel } from '../../layouts/Breadcrumbs';
import { useJob } from '../jobs/useJobs';
import { CommentThread } from './CommentThread';
import { ScorecardList } from './ScorecardList';
import { formatStage, type WireScore } from './useJobCandidates';
import {
  useApplication,
  useApplicationInterviews,
  useComments,
  useScorecards,
  type ApplicationDetailResponse,
  type InterviewResponse,
} from './useApplication';

/**
 * RC-06 — Candidate detail (§7.3; `GET /v1/applications/:id`).
 *
 * The route parameter is an APPLICATION id, not a person's id: someone may
 * apply to several jobs, and the record here is one application to this job.
 *
 * THREE THINGS §7.3 SPECIFIES THAT THE API CANNOT SERVE, all absent rather than
 * invented:
 *
 *   Parsed profile (work history, education, certifications) — `ParsedProfile`
 *   exists in the schema, but no endpoint reads one for a recruiter, and no
 *   parser runs anyway (`parseStatus` is always PENDING). Only the resume's
 *   metadata is available, so only that is shown.
 *
 *   Activity timeline — `StageHistory` is recorded server-side by FR5.4 but no
 *   controller exposes it.
 *
 *   Move stage — `PATCH /v1/applications/:id/stage` exists, but nothing lists a
 *   job's valid stage names, and the DTO takes a free-text `toStage`. A control
 *   here would either guess at stage names or invite a typo that silently moves
 *   a candidate into a stage that does not exist.
 *
 * Score override (RC-07) and interview scheduling (RC-11) are separate screens
 * and out of scope; interviews are read here, never created.
 */
export function CandidateDetailPage() {
  const { jobId, applicationId } = useParams<{ jobId: string; applicationId: string }>();

  const application = useApplication(applicationId);
  const scorecards = useScorecards(applicationId);
  const comments = useComments(applicationId);
  const interviews = useApplicationInterviews(applicationId);

  /*
   * Two breadcrumb labels: the candidate for this level, and the job for the
   * one above it. The job title comes from its own cached query rather than
   * `application.job.title` so that a deep link — where no job query has run —
   * still resolves the parent crumb.
   */
  const job = useJob(jobId);
  useBreadcrumbLabel(jobId, job.data?.title ?? application.data?.job.title);
  useBreadcrumbLabel(applicationId, application.data?.candidate.fullName);

  if (application.isPending) {
    return (
      <LoadingState label="Loading candidate…">
        <div className="space-y-4">
          <Skeleton className="h-[28px] w-64" />
          <SkeletonText lines={4} />
        </div>
      </LoadingState>
    );
  }

  // A 404 here covers "no such application" and "another tenant's" alike
  // (BR-06) — `ErrorState` already words that without picking one.
  if (application.isError) {
    return <ErrorState error={application.error} onRetry={() => void application.refetch()} />;
  }

  const detail = application.data;
  if (!detail) return null;

  /*
   * FR4.5 keys off the JOB's flag, not off `score` being null. Both look the
   * same on screen but mean different things, and the recruiter needs the
   * reason: scoring switched off for this job, versus a job that expects a
   * score and did not get one.
   *
   * THREE STATES, NOT TWO. The job is a separate request from the application,
   * so on a cold deep link there is a window where the flag is not known yet.
   * Defaulting that window to "enabled" made the panel read "No score is
   * available" — which claims the scorer ran and returned nothing — before
   * flipping to "AI scoring is disabled". `undefined` keeps the unknown
   * distinct so the panel can wait instead of guessing.
   */
  const aiScoringEnabled: boolean | undefined = job.data?.aiScoringEnabled;

  return (
    <div>
      <header className="mb-6">
        <p className="font-mono text-xs text-neutral-500">RC-06</p>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-neutral-900">{detail.candidate.fullName}</h1>
            <p className="mt-1 text-sm text-neutral-700">
              {detail.candidate.email}
              {detail.candidate.phone ? ` · ${detail.candidate.phone}` : ''}
            </p>
          </div>
          <div className="text-right">
            {/* Stage as stored: decision B2 makes stage names per-job and
                editable, so they are shown, never mapped to a fixed set. */}
            <span className="inline-flex rounded-full border border-neutral-300 px-2 py-0.5 text-xs font-semibold text-neutral-700">
              {formatStage(detail.currentStage)}
            </span>
            <p className="mt-2 text-xs text-neutral-500">Applied {formatDate(detail.appliedAt)}</p>
            <p className="font-mono text-xs text-neutral-500">{detail.reference}</p>
          </div>
        </div>

        <p className="mt-3 text-sm text-neutral-700">
          Applied to{' '}
          <Link to={`/jobs/${detail.job.id}`} className="text-primary-700 hover:underline">
            {detail.job.title}
          </Link>
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* §7.3 puts the assessment left and the collaboration right; with no
            parsed profile to show, the left column carries what does exist. */}
        <div className="space-y-4 lg:col-span-2">
          <ScorePanel
            score={detail.score}
            aiScoringEnabled={aiScoringEnabled}
            jobLoading={job.isPending}
          />
          <ApplicationFacts detail={detail} />
          <CommentThread applicationId={applicationId} query={comments} />
        </div>

        <div className="space-y-4">
          <ScorecardList query={scorecards} />
          <InterviewPanel query={interviews} />
        </div>
      </div>
    </div>
  );
}

/**
 * Score and rationale — one unit (BR-02, NFR7).
 *
 * The rationale is never optional: `WireScore` requires it, so the UI cannot
 * render a number without the reason for it even by accident.
 */
function ScorePanel({
  score,
  aiScoringEnabled,
  jobLoading,
}: {
  score: WireScore | null;
  /** `undefined` until the job's flag is known. */
  aiScoringEnabled: boolean | undefined;
  jobLoading: boolean;
}) {
  /*
   * WAIT RATHER THAN GUESS. Until the job answers, neither "disabled" nor "no
   * score" can be asserted, and picking either shows the recruiter a claim that
   * is then retracted. The skeleton occupies the same panel so nothing shifts
   * when the real state arrives.
   */
  if (jobLoading) {
    return (
      <section
        className="rounded-md border border-neutral-300 bg-neutral-0 p-4"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="sr-only">Loading score status…</span>
        <Skeleton className="h-[20px] w-40" />
        <div className="mt-3">
          <SkeletonText lines={2} />
        </div>
      </section>
    );
  }

  // Only a definitive `false` is FR4.5's disabled state.
  if (aiScoringEnabled === false) {
    return (
      // §8.2 assigns info/700 to AI-disabled notices. Not a warning: nothing is
      // wrong, the feature is switched off for this job.
      <section className="rounded-md border border-info-700 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-info-700">AI scoring is disabled</h2>
        <p className="mt-2 text-sm text-neutral-700">
          AI scoring is disabled for this job by your administrator, so this application has no
          score and no rationale. Assess the candidate from their resume and the team&rsquo;s
          scorecards.
        </p>
      </section>
    );
  }

  if (!score) {
    // The job expects a score and none came back — SY-02's reading rather than
    // FR4.5's. Stated, not left as an empty panel.
    return (
      <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
        <h2 className="text-base font-semibold text-neutral-900">Score</h2>
        <p className="mt-2 text-sm text-neutral-700">
          No score is available for this application yet.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-neutral-900">Score and rationale</h2>
        {score.overridden && (
          <span className="inline-flex rounded-sm border border-warning-700 px-2 py-0.5 text-xs font-semibold text-warning-700">
            Overridden
          </span>
        )}
      </div>

      {/*
        §8.2's semantic rule: magnitude uses the neutral/primary ramp, never
        success/danger — red on a low score would read as a rejection
        recommendation the system is forbidden to make (BR-01).
      */}
      <p className="mt-2 font-mono text-2xl font-semibold text-neutral-900">
        {score.composite.toFixed(2)}
      </p>
      <p className="mt-1 max-w-[70ch] text-sm text-neutral-700">{score.rationale.summary}</p>

      {score.rationale.factors.length > 0 && (
        <ul className="mt-3 space-y-1">
          {score.rationale.factors.map((factor) => (
            <li key={factor.feature} className="flex justify-between gap-4 text-sm">
              <span className="text-neutral-700">{factor.feature}</span>
              <span className="font-mono text-neutral-900">
                {/* The direction is the provider's own word; not recomputed
                    from the sign, which would be a second source of truth. */}
                {factor.direction} {factor.contribution.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 font-mono text-xs text-neutral-500">Model {score.modelVersion}</p>
    </section>
  );
}

/** What the API does hold about the application itself. */
function ApplicationFacts({ detail }: { detail: ApplicationDetailResponse }) {
  return (
    <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
      <h2 className="text-base font-semibold text-neutral-900">Application</h2>
      <dl className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Reference" value={detail.reference} mono />
        <Field label="Current stage" value={formatStage(detail.currentStage)} />
        <Field label="Applied" value={formatDate(detail.appliedAt)} />
        {/* FR7.3. Null here means "not recorded" — this app never shows a
            candidate, for whom the field would instead be withheld. */}
        <Field label="Source" value={detail.source} />
      </dl>

      <h3 className="mt-4 text-sm font-semibold text-neutral-900">Resume</h3>
      {detail.resume ? (
        <>
          <dl className="mt-2 grid gap-4 sm:grid-cols-2">
            <Field label="Uploaded" value={formatDate(detail.resume.uploadedAt)} />
            <Field label="File type" value={detail.resume.mimeType} mono />
            <Field label="Parse status" value={detail.resume.parseStatus} />
          </dl>
          <p className="mt-2 text-xs text-neutral-500">
            {/*
              Both facts stated because both surprise a reader: the file cannot
              be opened, and PENDING is not a stuck job.
            */}
            The file itself is not downloadable — the API withholds its storage location
            deliberately. Parsing is always pending in this phase: no parser runs yet (FR2.5), so
            there is no extracted profile to show.
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-neutral-500">No resume was attached to this application.</p>
      )}
    </section>
  );
}

/**
 * Interviews already arranged for this application (read-only).
 *
 * Scheduling one is RC-11 and is not built; `POST /v1/interviews` is not called
 * from here.
 */
function InterviewPanel({
  query,
}: {
  query: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    data: InterviewResponse[] | undefined;
    refetch: () => void;
  };
}) {
  return (
    <section className="rounded-md border border-neutral-300 bg-neutral-0 p-4">
      <h2 className="text-base font-semibold text-neutral-900">Interviews</h2>

      {query.isPending && (
        <div className="mt-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading interviews…</span>
          <SkeletonText lines={2} />
        </div>
      )}

      {query.isError && (
        <div className="mt-3">
          <ErrorState
            error={query.error}
            title="Interviews could not be loaded"
            onRetry={() => query.refetch()}
          />
        </div>
      )}

      {!query.isPending && !query.isError && (query.data?.length ?? 0) === 0 && (
        <p className="mt-2 text-sm text-neutral-500">No interviews arranged yet.</p>
      )}

      {query.data && query.data.length > 0 && (
        <ul className="mt-3 space-y-3">
          {query.data.map((interview) => (
            <li
              key={interview.id}
              className="border-t border-neutral-300 pt-3 first:border-0 first:pt-0"
            >
              <p className="text-sm font-semibold text-neutral-900">
                {formatStage(interview.status)}
              </p>
              <p className="mt-0.5 text-sm text-neutral-700">
                {interview.scheduledAt
                  ? `${formatDateTime(interview.scheduledAt)}${
                      interview.timezone ? ` (${interview.timezone})` : ''
                    }`
                  : // PENDING_SELECTION: the candidate has not chosen yet
                    // (FR6.2), so there is no time to show.
                    `Awaiting the candidate's choice — ${interview.slots.length} slot(s) offered`}
              </p>
              {interview.interviewers.length > 0 && (
                <p className="mt-1 text-xs text-neutral-500">
                  {interview.interviewers.map((person) => person.email).join(', ')}
                </p>
              )}
              {/* FR6.3 — null means it was arranged without a calendar
                  provider, which is a complete interview, not a failure. */}
              {!interview.calendarEventId && interview.scheduledAt && (
                <p className="mt-1 text-xs text-neutral-500">Arranged without a calendar invite.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd
        className={`mt-0.5 text-sm ${value ? 'text-neutral-900' : 'text-neutral-500'} ${
          mono && value ? 'font-mono' : ''
        }`}
      >
        {value ?? 'Not recorded'}
      </dd>
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
