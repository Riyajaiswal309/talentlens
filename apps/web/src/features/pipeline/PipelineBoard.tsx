import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton } from '../../components/Skeleton';
import { JobHeader } from '../jobs/JobHeader';
import { useJob } from '../jobs/useJobs';
import { useJobCandidates, type JobCandidateResponse } from '../candidates/useJobCandidates';
import { BulkActionBar } from './BulkActionBar';
import { CandidateCard } from './CandidateCard';
import { StageColumn } from './StageColumn';
import { groupByStage, useChangeStage, usePipelineStages, type PipelineStage } from './usePipeline';

/**
 * RC-09 — the pipeline board (Table 5.1; FR5.1, FR5.4; Flow 7), with RC-10's
 * bulk actions on top of it.
 *
 * COLUMNS COME FROM THE JOB'S OWN STAGES, fetched live — see
 * `usePipelineStages` for why the funnel endpoint is the source and when the
 * §14.1 defaults stand in.
 *
 * SELECTION LIVES HERE, not in the columns. A bulk action can span stages —
 * "move everyone in Screening and Interview to Offer" is one request — so the
 * set has to be owned above the columns that display it.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *   Drag-and-drop is not the interaction — `MoveStageMenu` explains why a
 *   keyboard-operable menu replaces a drag-only affordance (NFR4, WCAG 2.1.1).
 *   Tagging (RC-10's third action) has no endpoint or column anywhere in the
 *   API, so no control is offered for it.
 *   A stage filter (Table 5.1's secondary action) is omitted because
 *   `ListJobCandidatesQueryDto` accepts only `cursor` and `limit`, so any
 *   filter parameter would be a 400.
 */
export function PipelineBoard() {
  const { jobId } = useParams<{ jobId: string }>();

  const job = useJob(jobId);
  const candidates = useJobCandidates(jobId);
  const axis = usePipelineStages(jobId);
  const changeStage = useChangeStage(jobId);

  const rows = candidates.data?.pages.flatMap((page) => page.data) ?? [];
  const { columns, unknown } = groupByStage(rows, axis.stages);

  /*
   * RC-10's selection. A Set keeps membership checks cheap per card, and holding
   * ids rather than rows means a refetch cannot leave the selection pointing at
   * stale objects — only at ids, which is what the endpoint takes anyway.
   */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const toggle = useCallback((applicationId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(applicationId)) next.add(applicationId);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: string[], selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  /*
   * Only ids still on the board. A candidate can leave the loaded set — moved
   * by a colleague, or refetched out of view — and a selection that outlived its
   * card would silently include someone the recruiter can no longer see.
   */
  const selected = useMemo(
    () => rows.filter((row) => selectedIds.has(row.applicationId)).map((row) => row.applicationId),
    [rows, selectedIds],
  );

  /*
   * FR4.5 as a tri-state, the discipline RC-05 and RC-06 use: `undefined` while
   * the job's flag is unknown, so a score slot never appears and then vanishes
   * on a cold load.
   */
  const showScore = job.data ? job.data.aiScoringEnabled : undefined;
  const movingId = changeStage.isPending ? changeStage.variables?.applicationId : undefined;

  return (
    <div>
      <JobHeader
        job={job.data}
        loading={job.isPending}
        activeTab="pipeline"
        errored={job.isError}
      />

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold text-neutral-900">
          Pipeline
          {rows.length > 0 && (
            // "Loaded", not a total: the candidate list is cursor-paginated and
            // never reports a count (§23.1).
            <span className="ml-2 text-sm font-normal text-neutral-500">
              {rows.length} loaded{candidates.hasNextPage ? '+' : ''}
            </span>
          )}
        </h2>
        <p className="font-mono text-xs text-neutral-500">RC-09</p>
      </div>

      {/*
        Said out loud when the axis is not this job's own. A board drawn from
        defaults that silently claimed to be the job's pipeline would be a quiet
        lie about where candidates can go.

        GATED ON THE JOB EXISTING. `usingFallback` is true for any non-v4 id,
        including a garbage one — so on a 404 this banner used to appear above
        the "Not available" panel, telling the reader the job exists but its
        stages were unreadable. Two incompatible claims. With no job, the 404 is
        the only fact worth stating.
      */}
      {job.data && axis.usingFallback && (
        <p className="mb-4 rounded-sm border border-info-700 bg-neutral-0 px-3 py-2 text-sm text-info-700">
          Showing the six default stages. This job&rsquo;s own pipeline could not be read — the
          analytics endpoint that reports it only accepts version-4 job identifiers.
        </p>
      )}

      {/* A failed move keeps the board and reports the server's own sentence. */}
      {changeStage.error != null && (
        <div className="mb-4">
          <ErrorState error={changeStage.error} title="That candidate was not moved" />
        </div>
      )}

      {/* RC-10. Renders nothing until something is selected. */}
      <BulkActionBar
        jobId={jobId}
        stages={axis.stages}
        selected={selected}
        rows={rows}
        onClearSelection={clearSelection}
        // Only the confirmed ids leave the selection; failures stay selected so
        // they can be retried without picking them again.
        onCompleted={(succeededIds) => setMany(succeededIds, false)}
      />

      {candidates.isPending || axis.isPending ? (
        <LoadingState label="Loading the pipeline…">
          <div className="flex gap-4 overflow-x-auto pb-2">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-[220px] w-72 shrink-0" />
            ))}
          </div>
        </LoadingState>
      ) : candidates.isError ? (
        <ErrorState
          error={candidates.error}
          onRetry={() => void candidates.refetch()}
          as={job.isError ? 'h1' : 'h2'}
        />
      ) : (
        <>
          {rows.length === 0 && (
            <div className="mb-4">
              <EmptyState
                title="No applications yet"
                description="Share the job link to start receiving candidates. The stages below are this job's pipeline."
              />
            </div>
          )}

          {/*
            Horizontal scroll on the board only — the page itself never scrolls
            sideways, and each column keeps a fixed width so the layout does not
            reflow as counts change.
          */}
          <div className="flex gap-4 overflow-x-auto pb-2">
            {axis.stages.map((stage) => (
              <Column
                key={stage.name}
                stage={stage}
                rows={columns.get(stage.name) ?? []}
                jobId={jobId}
                stages={axis.stages}
                showScore={showScore}
                onMove={onMove}
                movingId={movingId}
                selectedIds={selectedIds}
                onToggle={toggle}
                onSetMany={setMany}
              />
            ))}

            {/*
              Cards whose stage the axis no longer lists. Kept visible rather
              than dropped — see `groupByStage`. Rendered only when non-empty,
              so the ordinary board is unaffected.
            */}
            {[...unknown.entries()].map(([name, unknownRows]) => (
              <StageColumn
                key={`unknown-${name}`}
                name={name}
                count={unknownRows.length}
                tone="unknown"
                emptyLabel="No candidates"
              >
                {unknownRows.map((row) => (
                  <CandidateCard
                    key={row.applicationId}
                    row={row}
                    jobId={jobId}
                    stages={axis.stages}
                    showScore={showScore}
                    onMove={(toStage) => onMove(row.applicationId, toStage)}
                    pending={movingId === row.applicationId}
                    selected={selectedIds.has(row.applicationId)}
                    onToggleSelect={() => toggle(row.applicationId)}
                  />
                ))}
              </StageColumn>
            ))}
          </div>

          {candidates.hasNextPage && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => void candidates.fetchNextPage()}
                disabled={candidates.isFetchingNextPage}
                aria-disabled={candidates.isFetchingNextPage}
                className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-100 disabled:opacity-40"
              >
                {candidates.isFetchingNextPage ? 'Loading…' : 'Load more candidates'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );

  function onMove(applicationId: string, toStage: string) {
    changeStage.mutate({ applicationId, toStage });
  }
}

function Column({
  stage,
  rows,
  jobId,
  stages,
  showScore,
  onMove,
  movingId,
  selectedIds,
  onToggle,
  onSetMany,
}: {
  stage: PipelineStage;
  rows: JobCandidateResponse[];
  jobId: string | undefined;
  stages: PipelineStage[];
  showScore: boolean | undefined;
  onMove: (applicationId: string, toStage: string) => void;
  movingId: string | undefined;
  selectedIds: ReadonlySet<string>;
  onToggle: (applicationId: string) => void;
  onSetMany: (ids: string[], selected: boolean) => void;
}) {
  const ids = rows.map((row) => row.applicationId);
  const selectedHere = ids.filter((id) => selectedIds.has(id)).length;
  const allSelected = ids.length > 0 && selectedHere === ids.length;

  return (
    <StageColumn
      name={stage.name}
      count={rows.length}
      isTerminal={stage.isTerminal}
      headerAction={
        // Per-column, because the useful bulk gesture is "everyone at this
        // stage". Hidden on an empty column, where it would toggle nothing.
        ids.length > 0 ? (
          <label className="flex cursor-pointer items-center gap-1 text-xs text-neutral-700">
            <input
              type="checkbox"
              checked={allSelected}
              // Partially selected is neither checked nor unchecked; the
              // indeterminate flag is what a checkbox has for exactly this.
              ref={(node) => {
                if (node) node.indeterminate = selectedHere > 0 && !allSelected;
              }}
              onChange={() => onSetMany(ids, !allSelected)}
              aria-label={`Select all ${ids.length} in ${stage.name}`}
              className="h-3.5 w-3.5 rounded-sm border-neutral-300 accent-primary-700"
            />
            All
          </label>
        ) : undefined
      }
    >
      {rows.map((row) => (
        <CandidateCard
          key={row.applicationId}
          row={row}
          jobId={jobId}
          stages={stages}
          showScore={showScore}
          onMove={(toStage) => onMove(row.applicationId, toStage)}
          pending={movingId === row.applicationId}
          selected={selectedIds.has(row.applicationId)}
          onToggleSelect={() => onToggle(row.applicationId)}
        />
      ))}
    </StageColumn>
  );
}
