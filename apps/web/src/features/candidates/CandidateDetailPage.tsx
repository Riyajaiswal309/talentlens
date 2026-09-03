import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton, SkeletonText } from '../../components/Skeleton';
import { DocumentIcon } from '../../components/icons';
import { Avatar, Badge, Card, CardHeader, Chip, Notice } from '../../components/ui';
import { useBreadcrumbLabel } from '../../layouts/Breadcrumbs';
import { useJob } from '../jobs/useJobs';
import { CommentThread } from './CommentThread';
import { ScorecardList } from './ScorecardList';
import { TagPanel } from './TagPanel';
import { ScorePanel } from './ScorePanel';
import { SkillGapPanel } from './SkillGapPanel';
import { InterviewPanel } from './InterviewPanel';
import { formatStage } from './useJobCandidates';
import {
  PARSE_REVIEW_THRESHOLD,
  useApplication,
  useApplicationInterviews,
  useComments,
  useScorecards,
  type ApplicationDetailResponse,
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
 * Score override (RC-07) is a separate screen. Interview scheduling (RC-11) is
 * NOT: an interview is always for one application, and no endpoint lists
 * interviews across a tenant, so it is arranged here in place rather than on a
 * route that would have nothing of its own to show.
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
    // The whole page — nothing else renders, so this carries the h1.
    return (
      <ErrorState error={application.error} onRetry={() => void application.refetch()} as="h1" />
    );
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
        <p className="font-mono text-2xs uppercase tracking-widest text-neutral-400">RC-06</p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar name={detail.candidate.fullName} size="lg" />
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-neutral-900">
                {detail.candidate.fullName}
              </h1>
              <p className="mt-1 text-sm text-neutral-500">
                {detail.candidate.email}
                {detail.candidate.phone ? ` · ${detail.candidate.phone}` : ''}
              </p>
              <p className="mt-1.5 text-sm text-neutral-500">
                Applied to{' '}
                <Link
                  to={`/jobs/${detail.job.id}`}
                  className="font-medium text-primary-700 hover:underline"
                >
                  {detail.job.title}
                </Link>
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1.5">
            {/* Stage as stored: decision B2 makes stage names per-job and
                editable, so they are shown, never mapped to a fixed set. */}
            <Badge tone="primary">{formatStage(detail.currentStage)}</Badge>
            <p className="text-xs text-neutral-500">Applied {formatDate(detail.appliedAt)}</p>
            <p className="font-mono text-xs text-neutral-400">{detail.reference}</p>
          </div>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* §7.3 puts the assessment left and the collaboration right; with no
            parsed profile to show, the left column carries what does exist. */}
        <div className="space-y-5 lg:col-span-2">
          <ScorePanel
            score={detail.score}
            aiScoringEnabled={aiScoringEnabled}
            jobLoading={job.isPending}
            applicationId={applicationId}
          />
          {/*
            Sits directly under the score because it is the same judgement in
            detail: the score's one measured feature is skill overlap, and this
            names the skills behind that number.
          */}
          <SkillGapPanel
            requiredSkills={job.data?.requiredSkills}
            candidateSkills={detail.resume?.parsedProfile?.skills ?? null}
            parsed={Boolean(detail.resume?.parsedProfile)}
          />
          <ApplicationFacts detail={detail} />
          <StageHistoryPanel detail={detail} />
          <CommentThread applicationId={applicationId} query={comments} />
        </div>

        <div className="space-y-5">
          <TagPanel applicationId={applicationId} />
          <ScorecardList applicationId={applicationId} query={scorecards} />
          <InterviewPanel applicationId={applicationId!} query={interviews} />
        </div>
      </div>
    </div>
  );
}

/** What the API does hold about the application itself. */
function ApplicationFacts({ detail }: { detail: ApplicationDetailResponse }) {
  return (
    <Card>
      <CardHeader title="Application" />
      <dl className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Reference" value={detail.reference} mono />
        <Field label="Current stage" value={formatStage(detail.currentStage)} />
        <Field label="Applied" value={formatDate(detail.appliedAt)} />
        {/* FR7.3. Null here means "not recorded" — this app never shows a
            candidate, for whom the field would instead be withheld. */}
        <Field label="Source" value={detail.source} />
      </dl>

      <div className="border-t border-neutral-200 p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
          <DocumentIcon className="h-4 w-4 text-neutral-400" />
          Resume
        </h3>
        {detail.resume ? (
          <>
            <dl className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Uploaded" value={formatDate(detail.resume.uploadedAt)} />
              <Field label="File type" value={detail.resume.mimeType} mono />
              <Field label="Parse status" value={detail.resume.parseStatus} />
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-neutral-500">
              The file itself is not downloadable — the API withholds its storage location
              deliberately.
            </p>
            <ParsedProfilePanel resume={detail.resume} />
          </>
        ) : (
          <p className="mt-2 text-sm text-neutral-400">
            No resume was attached to this application.
          </p>
        )}
      </div>
    </Card>
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

/**
 * FR3.1 / FR3.2 — what the parser read, and what a human still has to check.
 *
 * FOUR DISTINCT STATES, worded differently on purpose:
 *   PENDING     — queued, nothing attempted yet
 *   PROCESSING  — in flight
 *   FAILED      — attempted and could not be read; the application is STILL
 *                 valid (FR2.5), which the copy says explicitly
 *   COMPLETED   — parsed; fields shown, low-confidence ones flagged
 *
 * A COMPLETED parse with every field null is NOT the same as no parse, and the
 * panel distinguishes them: the first means "read, nothing found", the second
 * means "not attempted".
 *
 * THE NUMBERS ARE NOT MODEL CONFIDENCE. They are the strength of the
 * deterministic rule that produced each field, and the panel labels them that
 * way so nobody reads them as a classifier's probability.
 */
function ParsedProfilePanel({
  resume,
}: {
  resume: NonNullable<ApplicationDetailResponse['resume']>;
}) {
  const status = resume.parseStatus;
  const profile = resume.parsedProfile;

  if (status === 'PENDING' || status === 'PROCESSING') {
    return (
      <div className="mt-4">
        <Notice
          tone="neutral"
          title={status === 'PENDING' ? 'Parsing queued' : 'Parsing in progress'}
        >
          The resume has not been read yet. The application is already complete and valid — parsing
          never blocks intake (FR2.5).
        </Notice>
      </div>
    );
  }

  if (status === 'FAILED') {
    return (
      <div className="mt-4">
        <Notice tone="warning" title="This resume could not be read">
          Extraction failed for this file, so no fields were taken from it.{' '}
          <strong>The application is still valid</strong> and can be progressed normally — enter any
          details manually. Scanned or image-only PDFs are the usual cause; OCR is not available in
          this build.
        </Notice>
      </div>
    );
  }

  if (!profile) return null;

  const contact = profile.contact ?? {};
  const confidence = profile.fieldConfidence ?? {};
  const skills = profile.skills ?? [];
  const rows: Array<[string, string, string | null | undefined]> = [
    ['Name', 'contact.name', contact.name],
    ['Email', 'contact.email', contact.email],
    ['Phone', 'contact.phone', contact.phone],
    ['Location', 'contact.location', contact.location],
  ];
  const needsReview = Object.entries(confidence).filter(
    ([, value]) => value < PARSE_REVIEW_THRESHOLD,
  );

  return (
    <div className="mt-4 border-t border-neutral-200 pt-4">
      <h3 className="text-sm font-semibold text-neutral-900">Extracted from the resume</h3>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">
        Read by <span className="font-mono">{profile.parserName ?? 'unknown'}</span>
        {profile.parserVersion ? ` ${profile.parserVersion}` : ''} — a{' '}
        <strong>rule-based extractor, not a trained model</strong>. The percentages are how strong
        the matching rule was, not a model&rsquo;s confidence.
      </p>

      <dl className="mt-3 space-y-2">
        {rows.map(([label, key, value]) => {
          const score = confidence[key];
          const low = typeof score === 'number' && score < PARSE_REVIEW_THRESHOLD;
          return (
            <div key={key} className="flex flex-wrap items-baseline gap-2 text-sm">
              <dt className="w-24 shrink-0 text-neutral-500">{label}</dt>
              <dd
                className={`min-w-0 flex-1 break-words ${value ? 'text-neutral-900' : 'text-neutral-400'}`}
              >
                {value || 'Not found'}
              </dd>
              {typeof score === 'number' && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold ${
                    low
                      ? 'bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-200'
                      : 'bg-neutral-100 text-neutral-500'
                  }`}
                >
                  {Math.round(score * 100)}%{low ? ' · check' : ''}
                </span>
              )}
            </div>
          );
        })}
      </dl>

      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Skills</p>
        {skills.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {skills.map((skill) => (
              <li key={skill}>
                <Chip>{skill}</Chip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-neutral-400">
            None recognised. The parser matches a fixed vocabulary, so an unlisted technology is not
            found rather than missing from the resume.
          </p>
        )}
      </div>

      {needsReview.length > 0 && (
        <div className="mt-4">
          <Notice
            tone="warning"
            title={
              needsReview.length === 1
                ? '1 field needs checking'
                : `${needsReview.length} fields need checking`
            }
          >
            These scored below the review threshold and should be confirmed against the resume:{' '}
            {needsReview.map(([key]) => key.replace('contact.', '')).join(', ')}.
          </Notice>
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-neutral-500">
        Work history, education and certifications are <strong>not extracted</strong> by this parser
        — those sections must be read from the resume manually. This is a limitation of rule-based
        extraction, not an indication that the candidate lacks them.
      </p>
    </div>
  );
}

/**
 * FR5.4 — "every stage transition is recorded with actor and timestamp".
 *
 * READ-ONLY, and reads from the application detail the page already has: the
 * server embeds `stageHistory` there, so this needs no request of its own and
 * therefore has no loading or error state separate from the page's own. The
 * page above already renders `LoadingState` while the application is in flight
 * and `ErrorState` when it fails, so a second set here would be dead code that
 * could never display.
 *
 * THE OPENING STAGE IS SYNTHESISED FROM `appliedAt`, NOT INVENTED. A row is
 * written on transition, and creation is not a transition, so the first stage
 * has no entry. Showing the timeline without it would start the story midway;
 * the first item is therefore labelled from the application's own arrival time
 * and marked as the application being received, which is a fact the record
 * states directly.
 *
 * NULL means the caller may not see it (a Candidate), which is different from
 * an empty array — a candidate is told nothing rather than "no history".
 */
function StageHistoryPanel({ detail }: { detail: ApplicationDetailResponse }) {
  // Withheld for this role — render nothing rather than an empty panel.
  if (detail.stageHistory === null) return null;

  const history = detail.stageHistory;

  return (
    <Card>
      <CardHeader
        title="Stage history"
        description="Every recorded move through the pipeline, oldest first."
      />
      <div className="p-5">
        <ol className="relative space-y-5 border-l border-neutral-200 pl-6">
          {/* The arrival, from `appliedAt` — see the note above. */}
          <TimelineItem
            when={detail.appliedAt}
            title="Application received"
            detail={`Entered the pipeline${history.length === 0 ? ` at ${formatStage(detail.currentStage)}` : ''}.`}
            actor={null}
          />

          {history.map((entry, index) => (
            <TimelineItem
              // `changedAt` alone is not unique enough for a bulk move, which
              // can write several rows in the same transaction.
              key={`${entry.changedAt}-${entry.toStage}-${index}`}
              when={entry.changedAt}
              title={
                entry.fromStage
                  ? `${formatStage(entry.fromStage)} → ${formatStage(entry.toStage)}`
                  : `Moved to ${formatStage(entry.toStage)}`
              }
              detail={null}
              actor={entry.actorEmail}
            />
          ))}
        </ol>

        {history.length === 0 && (
          <p className="mt-5 text-sm text-neutral-500">
            No stage changes yet — this application is still at its first stage.
          </p>
        )}
      </div>
    </Card>
  );
}

function TimelineItem({
  when,
  title,
  detail,
  actor,
}: {
  when: string;
  title: string;
  detail: string | null;
  actor: string | null;
}) {
  return (
    <li className="relative">
      {/*
        Decorative only. The list is already an <ol>, so order is conveyed
        structurally; the dot adds nothing for a screen reader.
      */}
      <span
        aria-hidden="true"
        className="absolute -left-[1.9rem] top-1.5 h-2.5 w-2.5 rounded-full bg-primary-600 ring-4 ring-neutral-0"
      />
      <p className="text-sm font-semibold text-neutral-900">{title}</p>
      {detail && <p className="mt-0.5 text-sm text-neutral-500">{detail}</p>}
      <p className="mt-0.5 text-xs text-neutral-500">
        {/* A machine-readable timestamp beside the human one. */}
        <time dateTime={when}>{formatDateTime(when)}</time>
        {actor && (
          <>
            {' · '}
            <span className="break-words">{actor}</span>
          </>
        )}
      </p>
    </li>
  );
}
