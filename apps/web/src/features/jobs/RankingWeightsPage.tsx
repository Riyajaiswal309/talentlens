import { useEffect, useId, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton, SkeletonText } from '../../components/Skeleton';
import { JobHeader } from './JobHeader';
import { useJob } from './useJobs';
import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  MAX_WEIGHT,
  MIN_WEIGHT,
  useRankingWeights,
  useSetRankingWeights,
  weightSum,
  sumIsValid,
  type RankingWeights,
  type WeightsWriteResult,
} from './useRankingWeights';

/**
 * RC-08 — per-job ranking weights (Table 5.1; FR4.2, BR-07).
 *
 * SIX FIXED FEATURES, NO MORE. PRD §19.3 Table 19.1 closes the set, and
 * `feature-allow-list.ts` names it the enforcement point for BR-07 — no
 * protected attribute may become a model input. There is deliberately no way to
 * add a feature here.
 *
 * THE TOTAL MUST BE 1.0. The service rejects anything outside ±0.001, so the
 * running total is shown live and Save is blocked until it balances — a
 * recruiter should not have to discover that rule from a 400.
 *
 * WHAT THIS SCREEN WILL NOT CLAIM. The write returns `rescoreStatus`, and it is
 * `not_applicable` whenever the job has AI scoring off — which is every job in
 * this build. That is reported as-is: saying "candidates were re-ranked" when no
 * model runs would be the one thing this project has refused to do throughout.
 */
export function RankingWeightsPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();

  const job = useJob(jobId);
  const query = useRankingWeights(jobId);
  const save = useSetRankingWeights(jobId);

  const [draft, setDraft] = useState<RankingWeights | null>(null);

  // Seeded once the server's values arrive; not derived on every render, so
  // typing is never overwritten by a background refetch.
  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data.weights);
  }, [query.data, draft]);

  const closed = job.data?.status === 'CLOSED';

  return (
    <div>
      <JobHeader job={job.data} loading={job.isPending} activeTab="weights" errored={job.isError} />

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold text-neutral-900">Ranking weights</h2>
        <p className="font-mono text-xs text-neutral-500">RC-08</p>
      </div>

      {/*
        ERROR IS CHECKED FIRST, and the order is load-bearing: on a 404 the
        query stops pending but `draft` is never seeded, so testing `!draft`
        first left the page showing a skeleton forever instead of the refusal.
      */}
      {query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          as={job.isError ? 'h1' : 'h2'}
        />
      ) : query.isPending || !draft ? (
        <LoadingState label="Loading ranking weights…">
          <div className="space-y-4">
            <Skeleton className="h-[64px]" />
            <SkeletonText lines={6} />
          </div>
        </LoadingState>
      ) : (
        <WeightsForm
          view={query.data}
          draft={draft}
          onDraftChange={setDraft}
          closed={closed}
          save={save}
          onCancel={() => navigate(`/jobs/${jobId ?? ''}`)}
        />
      )}
    </div>
  );
}

function WeightsForm({
  view,
  draft,
  onDraftChange,
  closed,
  save,
  onCancel,
}: {
  view: { weights: RankingWeights; isDefault: boolean; updatedAt: string | null };
  draft: RankingWeights;
  onDraftChange: (weights: RankingWeights) => void;
  closed: boolean;
  save: ReturnType<typeof useSetRankingWeights>;
  onCancel: () => void;
}) {
  const total = weightSum(draft);
  const balanced = sumIsValid(draft);
  const dirty = FEATURE_KEYS.some((key) => draft[key] !== view.weights[key]);
  const totalId = useId();

  function set(key: (typeof FEATURE_KEYS)[number], value: number) {
    onDraftChange({ ...draft, [key]: value });
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-neutral-200 bg-neutral-0 shadow-card p-4">
        <p className="text-sm text-neutral-700">
          {view.isDefault ? (
            <>
              This job uses the <span className="font-semibold">documented default</span> weighting.
              No weighting has been saved for it yet.
            </>
          ) : (
            <>Last changed {formatDateTime(view.updatedAt)}.</>
          )}
        </p>
        {/*
          Stated up front, not buried under the Save button. The recruiter is
          about to tune something that changes nothing observable today.
        */}
        <p className="mt-2 text-sm text-neutral-700">
          These weights are applied when a candidate is scored. No model runs in this build, so
          saving them records the configuration for later rather than re-ranking anyone now.
        </p>
      </section>

      {closed && (
        <p className="rounded-sm border border-neutral-300 bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          This job is closed, so its weighting is read-only — the API refuses a change on a closed
          requisition.
        </p>
      )}

      <section className="rounded-lg border border-neutral-200 bg-neutral-0 shadow-card p-4">
        <h3 className="text-base font-semibold text-neutral-900">Features</h3>
        <p className="mt-1 text-sm text-neutral-700">
          The six inputs PRD Table 19.1 permits. Each between {MIN_WEIGHT} and {MAX_WEIGHT}.
        </p>

        <div className="mt-4 space-y-4">
          {FEATURE_KEYS.map((key) => (
            <WeightRow
              key={key}
              featureKey={key}
              value={draft[key]}
              disabled={closed || save.isPending}
              onChange={(value) => set(key, value)}
            />
          ))}
        </div>

        {/*
          The sum rule, live. `WEIGHT_SUM_TOLERANCE` is ±0.001 server-side, so a
          total of 0.999 or 1.001 is accepted and anything else is not.
        */}
        <div
          id={totalId}
          className={`mt-5 flex items-baseline justify-between gap-2 rounded-sm border px-3 py-2 ${
            balanced ? 'border-neutral-300' : 'border-danger-700'
          }`}
          role="status"
          aria-live="polite"
        >
          <span className="text-sm font-semibold text-neutral-900">Total</span>
          <span
            className={`font-mono text-sm font-semibold ${
              balanced ? 'text-neutral-900' : 'text-danger-700'
            }`}
          >
            {total.toFixed(4)} / 1.0000
          </span>
        </div>
        {!balanced && (
          <p role="alert" className="mt-1 text-sm text-danger-700">
            The six weights must add up to 1.0 before they can be saved.
          </p>
        )}
      </section>

      {/* The server's own sentence on a rejected write (409 on a closed job,
          400 if a bound slipped past the client checks). */}
      {save.error != null && <ErrorState error={save.error} title="The weighting was not saved" />}

      {save.data && <SaveOutcome result={save.data} />}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => save.mutate(draft)}
          disabled={closed || save.isPending || !balanced || !dirty}
          aria-disabled={closed || save.isPending || !balanced || !dirty}
          className="h-10 rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 shadow-sm transition-colors hover:bg-primary-800 disabled:opacity-40"
        >
          {save.isPending ? 'Saving…' : 'Save weighting'}
        </button>
        <button
          type="button"
          onClick={() => onDraftChange(view.weights)}
          disabled={!dirty || save.isPending}
          className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-100 disabled:opacity-40"
        >
          Reset to saved
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-100"
        >
          Back to the job
        </button>
        {!dirty && !save.data && <p className="text-sm text-neutral-500">No changes to save.</p>}
      </div>
    </div>
  );
}

/**
 * One feature's weight — a slider AND a number field, bound together.
 *
 * Two controls because §10.3 forbids a value conveyed by position alone: the
 * slider makes the balance visible, the number makes it exact and readable to a
 * screen reader. Both write the same state.
 */
function WeightRow({
  featureKey,
  value,
  disabled,
  onChange,
}: {
  featureKey: (typeof FEATURE_KEYS)[number];
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const id = useId();

  function parse(raw: string) {
    const next = Number(raw);
    if (Number.isNaN(next)) return;
    // Clamped to the DTO's [0, 1]; a paste outside it never reaches the server.
    onChange(Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Number(next.toFixed(4)))));
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-neutral-900">
          {FEATURE_LABELS[featureKey]}
        </label>
        {/* The stored identifier, so the screen maps onto the audit record. */}
        <span className="font-mono text-xs text-neutral-500">{featureKey}</span>
      </div>

      <div className="mt-1 flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={MIN_WEIGHT}
          max={MAX_WEIGHT}
          step={0.01}
          value={value}
          disabled={disabled}
          onChange={(event) => parse(event.target.value)}
          className="h-2 flex-1 accent-primary-700"
        />
        <input
          type="number"
          min={MIN_WEIGHT}
          max={MAX_WEIGHT}
          step={0.01}
          value={value}
          disabled={disabled}
          onChange={(event) => parse(event.target.value)}
          aria-label={`${FEATURE_LABELS[featureKey]} weight`}
          className="h-10 w-24 rounded-sm border border-neutral-300 px-2 text-right font-mono text-sm text-neutral-900 disabled:bg-neutral-100"
        />
      </div>
    </div>
  );
}

/**
 * What the write actually reported.
 *
 * `rescoreStatus` is printed as the API returned it. `not_applicable` means the
 * job has AI scoring off and nothing was queued — so the message says the
 * weighting was saved, and explicitly that no candidate was re-ranked.
 */
function SaveOutcome({ result }: { result: WeightsWriteResult }) {
  const queued = result.rescoreStatus === 'queued';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-md border bg-neutral-0 p-4 ${
        queued ? 'border-success-700' : 'border-info-700'
      }`}
    >
      <p className={`text-sm font-semibold ${queued ? 'text-success-700' : 'text-info-700'}`}>
        Weighting saved.
      </p>
      <dl className="mt-2 space-y-1 text-sm text-neutral-700">
        <div className="flex gap-2">
          <dt className="font-semibold">Applications on this job</dt>
          <dd className="font-mono">{result.affectedApplicationCount}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-semibold">Re-score status</dt>
          <dd className="font-mono">{result.rescoreStatus}</dd>
        </div>
      </dl>
      <p className="mt-2 text-sm text-neutral-700">
        {queued
          ? `A re-score was queued for ${result.affectedApplicationCount} ${
              result.affectedApplicationCount === 1 ? 'application' : 'applications'
            }.`
          : // The honest reading of `not_applicable`.
            'No re-score was queued: AI scoring is off for this job, so no candidate was re-ranked. The weighting is stored and will apply once scoring runs.'}
      </p>
    </div>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'never';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
