import { Badge, Card, CardHeader, Notice } from '../../components/ui';
import { Skeleton, SkeletonText } from '../../components/Skeleton';
import { ScoreOverrideForm } from './ScoreOverrideForm';
import type { WireScore } from './useJobCandidates';

/**
 * Score and rationale — one unit (BR-02, NFR7).
 *
 * The rationale is never optional: `WireScore` requires it, so the UI cannot
 * render a number without the reason for it even by accident.
 */
export function ScorePanel({
  score,
  aiScoringEnabled,
  jobLoading,
  applicationId,
  readOnly = false,
}: {
  score: WireScore | null;
  /** `undefined` until the job's flag is known. */
  aiScoringEnabled: boolean | undefined;
  jobLoading: boolean;
  applicationId: string | undefined;
  /**
   * Hides the override control (FR4.3).
   *
   * `PATCH /v1/applications/:id/score` is Recruiter and Admin only, so a
   * Hiring Manager reading the same score must not be shown a button that
   * would 403. The score and its rationale are identical for both — only the
   * ability to change it differs, which is exactly what this flag says.
   */
  readOnly?: boolean;
}) {
  /*
   * WAIT RATHER THAN GUESS. Until the job answers, neither "disabled" nor "no
   * score" can be asserted, and picking either shows the recruiter a claim that
   * is then retracted. The skeleton occupies the same panel so nothing shifts
   * when the real state arrives.
   */
  if (jobLoading) {
    return (
      <Card className="p-5">
        <div role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading score status…</span>
          <Skeleton className="h-[20px] w-40" />
          <div className="mt-3">
            <SkeletonText lines={2} />
          </div>
        </div>
      </Card>
    );
  }

  // Only a definitive `false` is FR4.5's disabled state.
  if (aiScoringEnabled === false) {
    return (
      // §8.2 assigns info/700 to AI-disabled notices. Not a warning: nothing is
      // wrong, the feature is switched off for this job.
      <Notice tone="info" title="AI scoring is disabled">
        AI scoring is disabled for this job by your administrator, so this application has no score
        and no rationale. Assess the candidate from their resume and the team&rsquo;s scorecards.
      </Notice>
    );
  }

  if (!score) {
    // The job expects a score and none came back — SY-02's reading rather than
    // FR4.5's. Stated, not left as an empty panel.
    return (
      <Card>
        <CardHeader title="Score" />
        <p className="p-5 text-sm text-neutral-500">
          No score is available for this application yet.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Score and rationale"
        action={score.overridden ? <Badge tone="warning">Overridden</Badge> : undefined}
      />
      <div className="p-5">
        {/*
          §8.2's semantic rule: magnitude uses the neutral/primary ramp, never
          success/danger — red on a low score would read as a rejection
          recommendation the system is forbidden to make (BR-01).
        */}
        <p className="font-mono text-3xl font-semibold text-neutral-900">
          {score.composite.toFixed(2)}
        </p>
        <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-neutral-700">
          {score.rationale.summary}
        </p>

        {score.rationale.factors.length > 0 && (
          <ul className="mt-4 space-y-2 border-t border-neutral-200 pt-4">
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

        <p className="mt-4 font-mono text-xs text-neutral-400">Model {score.modelVersion}</p>

        {/* FR4.3 — offered only here, where a score actually exists to change. */}
        {!readOnly && <ScoreOverrideForm applicationId={applicationId} score={score} />}
      </div>
    </Card>
  );
}
