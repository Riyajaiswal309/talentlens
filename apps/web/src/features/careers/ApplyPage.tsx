import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton, SkeletonText } from '../../components/Skeleton';
import { CheckIcon, DocumentIcon } from '../../components/icons';
import { Card, CardHeader, Notice, buttonClass } from '../../components/ui';
import { CareersLayout } from './CareersLayout';
import {
  APPLICATION_SOURCES,
  RESUME_ACCEPT_ATTR,
  SOURCE_LABELS,
  describeResumeProblem,
  formatBytes,
  useSubmitApplication,
  usePublicJob,
  type ApplicationDraft,
  type ApplicationSource,
  type SubmissionResult,
} from './usePublicJobs';

/**
 * FR2.1, FR2.2, FR2.4 — the public application flow.
 *
 * THREE STEPS: enter → review → confirmation.
 *
 * FR2.2 SAYS "candidates can review and correct any auto-filled field before
 * submission". NOTHING IS AUTO-FILLED IN THIS BUILD — no parser runs, so there
 * is nothing extracted to pre-populate. The review step is therefore a genuine
 * review of what the candidate TYPED, and the form says so in as many words
 * rather than implying an extraction happened. When a parser exists it fills
 * these same fields and this step needs no change; that is the whole reason it
 * is a step rather than a confirm dialog.
 *
 * FR2.5 governs the outcome: submission succeeds and returns a confirmation
 * regardless of parsing. The server queues the resume after the transaction
 * commits, so a 201 means the application is recorded whether or not the file
 * is ever read.
 */
export function ApplyPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const job = usePublicJob(jobId);
  const submit = useSubmitApplication();

  const [step, setStep] = useState<'form' | 'review'>('form');
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [draft, setDraft] = useState<ApplicationDraft>({
    fullName: '',
    email: '',
    phone: '',
    source: 'career_site',
    resume: null,
  });

  /*
   * Generated once per application attempt and reused on every retry, so a
   * dropped connection or an impatient second click cannot create two
   * applications. `POST /v1/applications` honours `Idempotency-Key`.
   */
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  if (job.isPending) {
    return (
      <CareersLayout>
        <LoadingState label="Loading this role…">
          <Skeleton className="h-[32px] w-80" />
          <div className="mt-4">
            <SkeletonText lines={4} />
          </div>
        </LoadingState>
      </CareersLayout>
    );
  }

  if (job.isError) {
    return (
      <CareersLayout>
        <ErrorState error={job.error} onRetry={() => void job.refetch()} as="h1" />
      </CareersLayout>
    );
  }

  if (result) {
    return <Confirmation result={result} />;
  }

  return (
    <CareersLayout>
      <p className="mb-4">
        <Link
          to={`/careers/${jobId ?? ''}`}
          className="text-sm font-semibold text-primary-700 hover:underline"
        >
          ← Back to the role
        </Link>
      </p>

      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
          Apply — {job.data?.title}
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          Step {step === 'form' ? '1' : '2'} of 2 ·{' '}
          {step === 'form' ? 'Your details' : 'Review and submit'}
        </p>
      </header>

      {step === 'form' ? (
        <DetailsStep draft={draft} onChange={setDraft} onContinue={() => setStep('review')} />
      ) : (
        <ReviewStep
          draft={draft}
          jobTitle={job.data?.title ?? ''}
          submitting={submit.isPending}
          error={submit.error}
          onBack={() => setStep('form')}
          onSubmit={() =>
            submit.mutate(
              { draft, jobId: jobId!, idempotencyKey: idempotencyKey.current },
              { onSuccess: setResult },
            )
          }
        />
      )}
    </CareersLayout>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 1 — details                                                            */
/* -------------------------------------------------------------------------- */

function DetailsStep({
  draft,
  onChange,
  onContinue,
}: {
  draft: ApplicationDraft;
  onChange: (draft: ApplicationDraft) => void;
  onContinue: () => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const nameId = useId();
  const emailId = useId();
  const phoneId = useId();
  const resumeId = useId();
  const sourceLegendId = useId();
  const summaryRef = useRef<HTMLDivElement>(null);

  function set<K extends keyof ApplicationDraft>(key: K, value: ApplicationDraft[K]) {
    onChange({ ...draft, [key]: value });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: Record<string, string> = {};

    if (!draft.fullName.trim()) next[nameId] = 'Enter your full name';
    // Mirrors `@IsEmail` so a typo is caught before an upload is spent on it.
    if (!draft.email.trim()) next[emailId] = 'Enter your email address';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()))
      next[emailId] = 'Enter a valid email address';

    if (!draft.resume) next[resumeId] = 'Attach your resume as a PDF or DOCX file';
    else {
      const problem = describeResumeProblem(draft.resume);
      if (problem) next[resumeId] = problem;
    }

    setErrors(next);
    if (Object.keys(next).length > 0) {
      // WCAG 3.3.1 — the summary is focused so a screen-reader user is taken
      // to the errors rather than left on a form that appeared to do nothing.
      summaryRef.current?.focus();
      return;
    }
    onContinue();
  }

  const errorList = Object.entries(errors);

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Notice tone="info" title="Fill these in yourself">
        Your resume is not read automatically — no parser runs in this build, so nothing is filled
        in for you. Enter your details below and you will be able to check them on the next step
        before anything is submitted.
      </Notice>

      {/*
        An error SUMMARY as well as per-field messages. WCAG 3.3.1 asks for the
        error to be identified in text; a summary at the top is what makes a long
        form usable when several fields fail at once.
      */}
      {errorList.length > 0 && (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          className="mt-5 rounded-md border border-danger-200 bg-danger-50 p-4"
        >
          <p className="text-sm font-semibold text-danger-700">
            {errorList.length === 1
              ? 'There is a problem with one field'
              : `There are problems with ${errorList.length} fields`}
          </p>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-danger-700">
            {errorList.map(([id, message]) => (
              <li key={id}>
                <a href={`#${id}`} className="underline">
                  {message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card className="mt-5">
        <CardHeader title="Your details" />
        <div className="space-y-5 p-5 sm:p-6">
          <TextField
            id={nameId}
            label="Full name"
            required
            value={draft.fullName}
            onChange={(value) => set('fullName', value)}
            error={errors[nameId]}
            autoComplete="name"
          />
          <TextField
            id={emailId}
            label="Email address"
            required
            type="email"
            value={draft.email}
            onChange={(value) => set('email', value)}
            error={errors[emailId]}
            autoComplete="email"
            hint="We use this to contact you about your application."
          />
          <TextField
            id={phoneId}
            label="Phone number"
            value={draft.phone}
            onChange={(value) => set('phone', value)}
            autoComplete="tel"
            hint="Optional."
          />

          <fieldset>
            <legend id={sourceLegendId} className="text-sm font-semibold text-neutral-900">
              How did you hear about this role?{' '}
              <span className="font-normal text-neutral-500">(Optional)</span>
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {APPLICATION_SOURCES.map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md border border-neutral-300 p-3 text-sm text-neutral-900 transition-colors hover:bg-neutral-50 has-[:checked]:border-primary-700 has-[:checked]:bg-primary-50"
                >
                  <input
                    type="radio"
                    name="source"
                    value={value}
                    checked={draft.source === value}
                    onChange={() => set('source', value as ApplicationSource)}
                    className="h-4 w-4 accent-primary-700"
                  />
                  {SOURCE_LABELS[value]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Card>

      <Card className="mt-5">
        <CardHeader title="Your resume" />
        <div className="p-5 sm:p-6">
          <ResumeField
            id={resumeId}
            file={draft.resume}
            error={errors[resumeId]}
            onChange={(file) => set('resume', file)}
          />
        </div>
      </Card>

      <div className="mt-6 flex flex-wrap gap-2">
        <button type="submit" className={buttonClass('primary')}>
          Review your application
        </button>
      </div>
    </form>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  required = false,
  type = 'text',
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
  type?: string;
  autoComplete?: string;
  hint?: string;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  // Both are referenced when both exist — `aria-describedby` takes a list.
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-neutral-900">
        {label}{' '}
        <span className="font-normal text-neutral-500">
          {required ? '(Required)' : '(Optional)'}
        </span>
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`h-11 w-full rounded-md border px-3 text-sm text-neutral-900 transition-colors ${
          error ? 'border-danger-700' : 'border-neutral-300 hover:border-neutral-400'
        }`}
      />
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-neutral-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-sm text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The resume picker.
 *
 * VALIDATED HERE AND AGAIN ON THE SERVER. This check spares the candidate a
 * 10 MB upload that was always going to be refused; the server additionally
 * verifies the file's MAGIC BYTES, so a renamed executable is rejected there
 * even when the browser reported an acceptable MIME type. The client check is
 * a courtesy, never the boundary.
 */
function ResumeField({
  id,
  file,
  error,
  onChange,
}: {
  id: string;
  file: File | null;
  error?: string;
  onChange: (file: File | null) => void;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-neutral-900">
        Resume <span className="font-normal text-neutral-500">(Required)</span>
      </label>
      <input
        id={id}
        type="file"
        accept={RESUME_ACCEPT_ATTR}
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
        className={`block w-full rounded-md border p-2.5 text-sm text-neutral-700 file:mr-3 file:rounded-md file:border-0 file:bg-primary-700 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-neutral-0 hover:file:bg-primary-800 ${
          error ? 'border-danger-700' : 'border-neutral-300'
        }`}
      />
      <p id={hintId} className="mt-1.5 text-xs text-neutral-500">
        PDF or DOCX, 10 MB or smaller.
      </p>

      {file && !error && (
        <p className="mt-3 flex items-center gap-2 rounded-md bg-neutral-50 p-3 text-sm text-neutral-700">
          <DocumentIcon className="h-4 w-4 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0 text-neutral-500">{formatBytes(file.size)}</span>
        </p>
      )}

      {error && (
        <p id={errorId} className="mt-1 text-sm text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 2 — review (FR2.2)                                                     */
/* -------------------------------------------------------------------------- */

function ReviewStep({
  draft,
  jobTitle,
  submitting,
  error,
  onBack,
  onSubmit,
}: {
  draft: ApplicationDraft;
  jobTitle: string;
  submitting: boolean;
  error: unknown;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Focus moves to the new step so a screen-reader user is told the page
  // changed — a step change inside one route is otherwise silent (WCAG 2.4.3).
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <div>
      <Notice tone="info" title="Check your details before submitting">
        Nothing has been sent yet. Anything below can still be corrected — choose “Go back and
        edit”. These values are the ones you typed; none were extracted from your resume.
      </Notice>

      <Card className="mt-5">
        <CardHeader title="Your application" description={`For ${jobTitle}`} />
        <dl className="divide-y divide-neutral-200">
          <ReviewRow label="Full name" value={draft.fullName} />
          <ReviewRow label="Email address" value={draft.email} />
          <ReviewRow label="Phone number" value={draft.phone} />
          <ReviewRow
            label="How you heard about us"
            value={draft.source ? SOURCE_LABELS[draft.source] : ''}
          />
          <ReviewRow
            label="Resume"
            value={draft.resume ? `${draft.resume.name} (${formatBytes(draft.resume.size)})` : ''}
          />
        </dl>
      </Card>

      <h2 ref={headingRef} tabIndex={-1} className="sr-only">
        Review and submit your application
      </h2>

      {error != null && (
        <div className="mt-5">
          {/*
            The server's own sentence. A file that passed the browser's checks
            can still fail the magic-byte check, and that message names the fix.
          */}
          <ErrorState error={error} title="Your application was not submitted" />
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          aria-disabled={submitting}
          className={buttonClass('primary')}
        >
          {submitting ? 'Submitting…' : 'Submit application'}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          aria-disabled={submitting}
          className={buttonClass('secondary')}
        >
          Go back and edit
        </button>
      </div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-2 px-5 py-3.5 sm:px-6">
      <dt className="w-56 shrink-0 text-sm font-semibold text-neutral-700">{label}</dt>
      <dd
        className={`min-w-0 flex-1 break-words text-sm ${value ? 'text-neutral-900' : 'text-neutral-400'}`}
      >
        {value || 'Not provided'}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Confirmation (FR2.5)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The confirmation.
 *
 * THE REFERENCE IS THE ONLY RECEIPT, and that is stated plainly. There is no
 * candidate login in this build and `GET /v1/applications/:id` is guarded by
 * `CandidateOwnershipGuard`, so no public page can look an application up
 * later — offering a "track your application" link would either fail or
 * require bypassing that guard. FR2.3's email confirmation is blocked for the
 * same reason no invitation exists: no mail provider is configured.
 */
function Confirmation({ result }: { result: SubmissionResult }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <CareersLayout>
      <div className="mx-auto max-w-2xl text-center">
        <span
          aria-hidden="true"
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-50 text-success-700 ring-1 ring-inset ring-success-200"
        >
          <CheckIcon className="h-7 w-7" />
        </span>

        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-5 text-3xl font-semibold tracking-tight text-neutral-900"
        >
          Application received
        </h1>
        <p className="mt-3 text-base text-neutral-700">
          Thank you for applying for <strong>{result.jobTitle}</strong>. Your application has been
          recorded.
        </p>

        <Card className="mt-8 text-left">
          <CardHeader title="Your reference" />
          <div className="p-5 sm:p-6">
            <p className="select-all break-all font-mono text-lg font-semibold text-neutral-900">
              {result.reference}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-neutral-500">
              Keep this reference. It is the only receipt you will get:{' '}
              <strong>no confirmation email is sent</strong> — this build has no mail provider
              configured — and there is no online status page, because applying does not create an
              account.
            </p>
            <dl className="mt-5 grid gap-4 border-t border-neutral-200 pt-5 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Current stage
                </dt>
                <dd className="mt-1 text-sm text-neutral-900">{result.currentStage}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Received
                </dt>
                <dd className="mt-1 text-sm text-neutral-900">
                  {new Date(result.appliedAt).toLocaleString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </dd>
              </div>
            </dl>
          </div>
        </Card>

        <p className="mt-8">
          <Link to="/careers" className={buttonClass('secondary')}>
            Browse other roles
          </Link>
        </p>
      </div>
    </CareersLayout>
  );
}
