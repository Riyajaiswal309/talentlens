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
  children,
}: {
  name: string;
  count: number;
  isTerminal?: boolean;
  emptyLabel?: string;
  /** `unknown` marks a column the job's stage axis no longer lists. */
  tone?: 'stage' | 'unknown';
  children: ReactNode;
}) {
  return (
    <section
      className="flex w-72 shrink-0 flex-col rounded-md border border-neutral-300 bg-neutral-100"
      aria-label={`${name}, ${count} ${count === 1 ? 'candidate' : 'candidates'}`}
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-neutral-300 px-3 py-2">
        <h3 className="text-sm font-semibold text-neutral-900">
          {name}
          {isTerminal && (
            // Stated, never coloured: "terminal" describes the pipeline, not a
            // verdict on the candidate (§8.2, BR-01).
            <span className="ml-2 rounded-sm border border-neutral-300 px-1.5 py-0.5 text-xs font-normal text-neutral-500">
              Final
            </span>
          )}
          {tone === 'unknown' && (
            <span className="ml-2 rounded-sm border border-warning-700 px-1.5 py-0.5 text-xs font-normal text-warning-700">
              Not on this job
            </span>
          )}
        </h3>
        {/* The count badge Flow 7 expects to update after a move. */}
        <span className="font-mono text-xs font-semibold text-neutral-700">{count}</span>
      </header>

      <div className="flex-1 space-y-2 p-3">
        {count === 0 ? (
          <p className="rounded-sm border border-dashed border-neutral-300 px-3 py-6 text-center text-xs text-neutral-500">
            {emptyLabel}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
