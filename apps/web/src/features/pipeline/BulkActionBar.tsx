import { useId, useState } from 'react';
import { ErrorState } from '../../components/ErrorState';
import type { JobCandidateResponse } from '../candidates/useJobCandidates';
import type { PipelineStage } from './usePipeline';
import { MAX_BULK_APPLICATIONS, partitionSelectable, useBulkStage } from './useBulkStage';
import { MAX_TAG_LENGTH, useBulkTag } from './useBulkTag';
import { useToast } from '../../components/Toast';

/**
 * RC-10 — the bulk action panel (Table 5.1; FR5.2; Flow 7 step 6, US-11).
 *
 * APPEARS ONLY WHEN SOMETHING IS SELECTED, and reports "selection count, action
 * menu, confirm dialog" as Table 5.1 specifies. It is a toolbar of native
 * controls — a `<select>` and buttons — so it is keyboard operable without any
 * ARIA of its own, matching why RC-09 uses a menu rather than drag (NFR4).
 *
 * TAG IS NOT IMPLEMENTED. Table 5.1 lists "Change stage, Reject, Tag", but no
 * endpoint and no column exists for a tag anywhere in the API — there is
 * nothing to send it to, so the control is absent rather than inert.
 *
 * REJECT IS A STAGE CHANGE, not a separate verb. The API has no reject route;
 * `Rejected` is a terminal stage on the job's pipeline. It gets its own button
 * because Table 5.1 names it as an action and BR-01 wants the destructive one
 * unmistakable, but it posts the same request as any other move.
 */
export function BulkActionBar({
  jobId,
  stages,
  selected,
  rows,
  onClearSelection,
  onCompleted,
}: {
  jobId: string | undefined;
  stages: PipelineStage[];
  /** Application ids, in selection order. */
  selected: string[];
  /** The loaded rows, used to name candidates in the confirmation. */
  rows: JobCandidateResponse[];
  onClearSelection: () => void;
  /** Called with the ids that succeeded, so the caller can deselect them. */
  onCompleted: (succeededIds: string[]) => void;
}) {
  const bulk = useBulkStage(jobId);
  const bulkTag = useBulkTag();
  const { notify } = useToast();
  const [tagLabel, setTagLabel] = useState('');
  const tagId = useId();
  const [target, setTarget] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const selectId = useId();

  /**
   * FR5.2 — tag every selected application.
   *
   * The server decides what is taggable; nothing is filtered here. Its response
   * separates written from already-present, and the confirmation reports both
   * rather than claiming a count that includes no-ops.
   */
  function applyTag() {
    const label = tagLabel.trim().replace(/\s+/g, ' ');
    if (!label) return;
    setLocalError(null);

    bulkTag.mutate(
      { applicationIds: selected, label },
      {
        onSuccess: (outcome) => {
          setTagLabel('');
          const parts = [`Tagged ${outcome.tagged.length}`];
          if (outcome.alreadyTagged.length > 0) {
            parts.push(`${outcome.alreadyTagged.length} already had it`);
          }
          if (outcome.failed.length > 0) {
            parts.push(`${outcome.failed.length} could not be tagged`);
          }
          notify(`${parts.join(' · ')} — “${outcome.label}”.`);
        },
      },
    );
  }

  if (selected.length === 0) return null;

  const rejectedStage = stages.find((stage) => stage.name === 'Rejected');
  const overCap = selected.length > MAX_BULK_APPLICATIONS;
  const result = bulk.data;

  function apply(stageName: string) {
    setLocalError(null);

    if (!stageName) {
      setLocalError('Choose a stage to move the selection to.');
      return;
    }
    if (overCap) {
      setLocalError(`A bulk action may cover at most ${MAX_BULK_APPLICATIONS} candidates.`);
      return;
    }

    /*
     * One non-v4 id would 400 the entire batch, taking every other selected
     * candidate down with it — so those are held back and named instead.
     */
    const { sendable, rejected } = partitionSelectable(selected);
    if (sendable.length === 0) {
      setLocalError('None of the selected candidates can be updated in bulk.');
      return;
    }

    const stage = stages.find((s) => s.name === stageName);
    if (stage?.isTerminal) {
      /*
       * BR-01 — a terminal transition needs explicit human authorship, and in
       * bulk that matters more, not less: the count is stated so nobody rejects
       * more people than they meant to.
       */
      const message =
        stageName === 'Rejected'
          ? `Reject ${sendable.length} ${sendable.length === 1 ? 'candidate' : 'candidates'}? This is a final decision and each one is notified.`
          : `Move ${sendable.length} ${sendable.length === 1 ? 'candidate' : 'candidates'} to ${stageName}? This is a terminal stage and each one is notified.`;
      if (!window.confirm(message)) return;
    }

    bulk.mutate(
      { applicationIds: sendable, toStage: stageName },
      {
        onSuccess: (response) => {
          // Only what the server confirmed leaves the selection; anything that
          // failed stays selected so it can be retried without re-picking.
          onCompleted(response.succeeded);
          setTarget('');
          if (rejected.length > 0) {
            setLocalError(
              `${rejected.length} selected ${rejected.length === 1 ? 'candidate was' : 'candidates were'} skipped — their identifiers are not accepted by the bulk endpoint.`,
            );
          }
        },
      },
    );
  }

  return (
    <div
      className="mb-4 rounded-lg border border-primary-200 bg-primary-50 p-4 shadow-card"
      /*
       * A live region: the bar appears in response to a selection made
       * elsewhere on the page, so its arrival is announced rather than left for
       * a screen-reader user to discover.
       */
      role="region"
      aria-label="Bulk actions"
    >
      <div className="flex flex-wrap items-end gap-3">
        <p className="text-sm font-semibold text-neutral-900" aria-live="polite">
          {selected.length} {selected.length === 1 ? 'candidate' : 'candidates'} selected
        </p>

        <div>
          <label htmlFor={selectId} className="mb-1 block text-xs font-semibold text-neutral-900">
            Move to stage
          </label>
          {/* Only this job's real stages — the API validates `toStage` against
              them and rejects anything else. */}
          <select
            id={selectId}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            disabled={bulk.isPending}
            className="h-10 w-48 rounded-md border border-neutral-300 bg-neutral-0 px-3 text-sm text-neutral-900 disabled:opacity-40"
          >
            <option value="">Choose a stage…</option>
            {stages.map((stage) => (
              <option key={stage.name} value={stage.name}>
                {stage.name}
                {stage.isTerminal ? ' (final)' : ''}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => apply(target)}
          disabled={bulk.isPending || !target}
          aria-disabled={bulk.isPending || !target}
          className="h-10 rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 shadow-sm transition-colors hover:bg-primary-800 disabled:opacity-40"
        >
          {bulk.isPending ? 'Applying…' : 'Move'}
        </button>

        {/* §8.6 reserves the danger variant for a confirmed destructive action. */}
        {rejectedStage && (
          <button
            type="button"
            onClick={() => apply('Rejected')}
            disabled={bulk.isPending}
            aria-disabled={bulk.isPending}
            className="h-10 rounded-md bg-danger-700 px-4 text-sm font-semibold text-neutral-0 shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Reject
          </button>
        )}

        {/*
          FR5.2 — bulk tagging, alongside the stage actions rather than on a
          separate surface: the selection is already made here, and asking a
          recruiter to re-pick the same candidates elsewhere would be the only
          alternative.
        */}
        <div>
          <label htmlFor={tagId} className="mb-1 block text-xs font-semibold text-neutral-900">
            Tag selected
          </label>
          <div className="flex gap-2">
            <input
              id={tagId}
              type="text"
              value={tagLabel}
              onChange={(event) => setTagLabel(event.target.value)}
              maxLength={MAX_TAG_LENGTH}
              placeholder="e.g. Shortlist"
              disabled={bulkTag.isPending}
              className="h-10 w-44 rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 disabled:opacity-40"
            />
            <button
              type="button"
              onClick={applyTag}
              disabled={bulkTag.isPending || tagLabel.trim().length === 0}
              aria-disabled={bulkTag.isPending || tagLabel.trim().length === 0}
              className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-100 disabled:opacity-40"
            >
              {bulkTag.isPending ? 'Tagging…' : 'Tag'}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            bulk.reset();
            bulkTag.reset();
            setLocalError(null);
            setTagLabel('');
            onClearSelection();
          }}
          disabled={bulk.isPending}
          className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-100 disabled:opacity-40"
        >
          Clear selection
        </button>
      </div>

      {localError && (
        <p role="alert" className="mt-3 text-sm text-danger-700">
          {localError}
        </p>
      )}

      {/*
        A transport-level failure — the request never produced a result. Distinct
        from a 200 carrying failures, which is rendered below.
      */}
      {bulk.error != null && (
        <div className="mt-3">
          <ErrorState error={bulk.error} title="The bulk action could not be applied" />
        </div>
      )}

      {bulkTag.error != null && (
        <div className="mt-3">
          <ErrorState error={bulkTag.error} title="The tag could not be applied" />
        </div>
      )}

      {result && <BulkOutcome result={result} rows={rows} />}
    </div>
  );
}

/**
 * Table 5.1's "partial failure" state.
 *
 * BOTH LISTS ARE SHOWN, ALWAYS. A batch where nine moved and one did not is
 * neither a success nor an error, and reporting only the total would hide the
 * one candidate who still needs attention.
 */
function BulkOutcome({
  result,
  rows,
}: {
  result: { succeeded: string[]; failed: { id: string; reason: string }[] };
  rows: JobCandidateResponse[];
}) {
  const nameFor = (id: string) =>
    rows.find((row) => row.applicationId === id)?.candidate.fullName ?? id.slice(0, 8);

  return (
    <div role="status" aria-live="polite" className="mt-3 space-y-2 text-sm">
      {result.succeeded.length > 0 && (
        <p className="text-success-700">
          {result.succeeded.length} {result.succeeded.length === 1 ? 'candidate' : 'candidates'}{' '}
          updated.
        </p>
      )}

      {result.failed.length > 0 && (
        <div>
          <p className="font-semibold text-danger-700">
            {result.failed.length} could not be updated:
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.failed.map((failure) => (
              <li key={failure.id} className="text-neutral-700">
                {/* The server's own reason, verbatim — "Not found", or the
                    message naming the job's valid stages. */}
                {nameFor(failure.id)} — {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.succeeded.length === 0 && result.failed.length === 0 && (
        <p className="text-neutral-700">Nothing was changed.</p>
      )}
    </div>
  );
}
