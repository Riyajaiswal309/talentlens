import { useParams } from 'react-router-dom';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, Skeleton } from '../../components/Skeleton';
import { JobHeader } from '../jobs/JobHeader';
import { useJob } from '../jobs/useJobs';
import { useJobCandidates, type JobCandidateResponse } from '../candidates/useJobCandidates';
import { CandidateCard } from './CandidateCard';
import { StageColumn } from './StageColumn';
import { groupByStage, useChangeStage, usePipelineStages, type PipelineStage } from './usePipeline';

/**
 * RC-09 — the pipeline board (Table 5.1; FR5.1, FR5.4; Flow 7).
 *
 * COLUMNS COME FROM THE JOB'S OWN STAGES, fetched live — see
 * `usePipelineStages` for why the funnel endpoint is the source and when the
 * §14.1 defaults stand in.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *   Bulk select is RC-10, a separate screen, out of scope here.
 *   Drag-and-drop is not the interaction — `MoveStageMenu` explains why a
 *   keyboard-operable menu replaces a drag-only affordance (NFR4, WCAG 2.1.1).
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
   * FR4.5 as a tri-state, the discipline RC-05 and RC-06 use: `undefined` while
   * the job's flag is unknown, so a score slot never appears and then vanishes
   * on a cold load.
   */
  const showScore = job.data ? job.data.aiScoringEnabled : undefined;
  const movingId = changeStage.isPending ? changeStage.variables?.applicationId : undefined;

  return (
    <div>
      <JobHeader job={job.data} loading={job.isPending} activeTab="pipeline" />

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
      */}
      {axis.usingFallback && (
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

      {candidates.isPending || axis.isPending ? (
        <LoadingState label="Loading the pipeline…">
          <div className="flex gap-4 overflow-x-auto pb-2">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-[220px] w-72 shrink-0" />
            ))}
          </div>
        </LoadingState>
      ) : candidates.isError ? (
        <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} />
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
                className="h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-40"
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
}: {
  stage: PipelineStage;
  rows: JobCandidateResponse[];
  jobId: string | undefined;
  stages: PipelineStage[];
  showScore: boolean | undefined;
  onMove: (applicationId: string, toStage: string) => void;
  movingId: string | undefined;
}) {
  return (
    <StageColumn name={stage.name} count={rows.length} isTerminal={stage.isTerminal}>
      {rows.map((row) => (
        <CandidateCard
          key={row.applicationId}
          row={row}
          jobId={jobId}
          stages={stages}
          showScore={showScore}
          onMove={(toStage) => onMove(row.applicationId, toStage)}
          pending={movingId === row.applicationId}
        />
      ))}
    </StageColumn>
  );
}
