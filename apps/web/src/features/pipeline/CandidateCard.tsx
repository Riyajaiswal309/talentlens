import { Link } from 'react-router-dom';
import type { JobCandidateResponse } from '../candidates/useJobCandidates';
import { MoveStageMenu } from './MoveStageMenu';
import type { PipelineStage } from './usePipeline';

/**
 * One candidate on the board (RC-09 — "candidate cards with score badge").
 *
 * THE SCORE BADGE OBEYS FR4.5. `showScore` is driven by the JOB's
 * `aiScoringEnabled`, not by whether this row happens to carry a score, and it
 * is `undefined` until the job answers — so an unscored board never briefly
 * shows a score slot that then disappears. Same rule as RC-05.
 */
export function CandidateCard({
  row,
  jobId,
  stages,
  showScore,
  onMove,
  pending,
  selected,
  onToggleSelect,
}: {
  row: JobCandidateResponse;
  jobId: string | undefined;
  stages: PipelineStage[];
  /** `undefined` while the job's AI flag is unknown. */
  showScore: boolean | undefined;
  onMove: (toStage: string) => void;
  pending: boolean;
  /** RC-10 — part of the current bulk selection. */
  selected: boolean;
  onToggleSelect: () => void;
}) {
  return (
    <article
      className={`rounded-md border bg-neutral-0 p-3 ${
        // A selected card is outlined rather than tinted, so the selection reads
        // at a glance without competing with the stage colouring.
        selected ? 'border-primary-700' : 'border-neutral-300'
      } ${
        // Flow 7's "subtle in-flight indicator" while the move is in the air.
        pending ? 'opacity-60' : ''
      }`}
      aria-busy={pending}
    >
      <div className="flex items-start gap-2">
        {/*
          A native checkbox, labelled with the candidate's name — five identical
          "select" controls in a column would otherwise be indistinguishable to
          a screen reader (NFR4).
        */}
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          disabled={pending}
          aria-label={`Select ${row.candidate.fullName} for bulk actions`}
          className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-neutral-300 accent-primary-700"
        />
        <Link
          to={`/jobs/${jobId ?? ''}/candidates/${row.applicationId}`}
          className="rounded-sm text-sm font-semibold text-primary-700 hover:underline"
        >
          {row.candidate.fullName}
        </Link>
      </div>
      <p className="mt-0.5 truncate text-xs text-neutral-700" title={row.candidate.email}>
        {row.candidate.email}
      </p>
      <p className="mt-1 text-xs text-neutral-500">Applied {formatDate(row.appliedAt)}</p>

      {showScore === true && (
        <p className="mt-2 text-xs">
          {row.score ? (
            <>
              {/*
                §8.2 — magnitude stays on the neutral/primary ramp. A red low
                score would read as a rejection recommendation, which BR-01
                forbids the system from making.
              */}
              <span className="font-mono font-semibold text-neutral-900">
                {row.score.composite.toFixed(2)}
              </span>
              {row.score.overridden && (
                <span className="ml-2 rounded-sm border border-warning-700 px-1.5 py-0.5 text-xs font-semibold text-warning-700">
                  Overridden
                </span>
              )}
            </>
          ) : (
            <span className="text-neutral-500">No score available</span>
          )}
        </p>
      )}

      <div className="mt-3">
        <MoveStageMenu
          stages={stages}
          currentStage={row.currentStage}
          candidateName={row.candidate.fullName}
          onMove={onMove}
          pending={pending}
        />
      </div>
    </article>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
