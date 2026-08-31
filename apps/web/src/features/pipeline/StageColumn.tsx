import type { ReactNode } from 'react';

/**
 * One Kanban column (RC-09).
 *
 * THE EMPTY COLUMN IS A SPECIFIED STATE, not an oversight — Table 5.1 lists
 * "empty column" and Flow 7 asks for a placeholder there. A column with no
 * candidates still renders its header and count so the pipeline's shape is
 * visible whether or not anyone is in it.
 */
export function StageColumn({
  name,
  count,
  isTerminal,
  emptyLabel = 'No candidates in this stage',
  tone = 'stage',
  headerAction,
  children,
}: {
  name: string;
  count: number;
  isTerminal?: boolean;
  emptyLabel?: string;
  /** `unknown` marks a column the job's stage axis no longer lists. */
  tone?: 'stage' | 'unknown';
  /** RC-10's per-column select-all. Omitted when the column is empty. */
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      /*
        `min-h` keeps the six columns the same height whatever they hold, so a
        board with one busy stage does not leave a ragged strip of dead space
        beside the empty ones.
      */
      className="flex min-h-[26rem] w-72 shrink-0 flex-col rounded-lg border border-neutral-200 bg-neutral-100/70"
      aria-label={`${name}, ${count} ${count === 1 ? 'candidate' : 'candidates'}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3.5 py-3">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-neutral-900">
          {name}
          {isTerminal && (
            // Stated, never coloured: "terminal" describes the pipeline, not a
            // verdict on the candidate (§8.2, BR-01).
            <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-neutral-500">
              Final
            </span>
          )}
          {tone === 'unknown' && (
            <span className="rounded-full bg-warning-50 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-warning-700 ring-1 ring-inset ring-warning-200">
              Not on this job
            </span>
          )}
        </h3>
        <div className="flex shrink-0 items-center gap-2">
          {headerAction}
          {/* The count badge Flow 7 expects to update after a move. */}
          <span className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-neutral-0 px-1.5 font-mono text-xs font-semibold tabular-nums text-neutral-700 ring-1 ring-inset ring-neutral-200">
            {count}
          </span>
        </div>
      </header>

      <div className="flex-1 space-y-2.5 p-3">
        {count === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 px-3 py-8 text-center text-xs text-neutral-500">
            {emptyLabel}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
