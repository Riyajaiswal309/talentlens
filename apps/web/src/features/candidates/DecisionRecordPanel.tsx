import { Badge, Card, CardHeader, Notice } from '../../components/ui';
import type { ApplicationDetailResponse } from './useApplication';
import { formatStage } from './useJobCandidates';

/**
 * Who decided what, and what merely advised.
 *
 * THE SEPARATION IS THE FEATURE. A recruiter looking at a scored candidate has
 * two very different kinds of information in front of them, and an ATS that
 * blurs them is how an "AI rejection" happens: the score is advisory output
 * from a rule-based scorer, while every movement through the pipeline was an
 * act by a named person at a known time. This panel states which is which,
 * because BR-01 forbids the system from making the decision and that guarantee
 * is worth nothing if the interface does not show it.
 *
 * EVERY LINE IS PERSISTED DATA. Stage movements come from `stage_history` with
 * the actor and timestamp the server recorded; scorecards and comments are
 * counted from what reviewers actually submitted. Nothing is inferred, and no
 * decision is attributed to anyone who did not make it.
 *
 * WHAT THIS PANEL CANNOT SHOW — and says so rather than leaving a blank: the
 * REASON for a stage change. `stage_history` stores `from_stage`, `to_stage`,
 * `changed_by` and `changed_at`, and `ChangeStageDto` accepts only `toStage`;
 * there is no reason column and no field to send one. Recording a structured
 * decision reason would need a schema and API change, so this points the
 * recruiter at the comment thread, which is where a reason can actually live
 * today (FR5.3).
 */
export function DecisionRecordPanel({
  detail,
  scorecardCount,
  commentCount,
}: {
  detail: ApplicationDetailResponse;
  scorecardCount: number | undefined;
  commentCount: number | undefined;
}) {
  const history = detail.stageHistory ?? [];
  const latest = history.length > 0 ? history[history.length - 1] : undefined;

  return (
    <Card>
      <CardHeader
        title="Decision record"
        description="What the system advised, and what people decided."
      />

      <div className="divide-y divide-neutral-200">
        {/* ---------------------------------------------------------------- */}
        <section className="p-5">
          <div className="flex items-center gap-2">
            <Badge tone="neutral">Automated</Badge>
            <h3 className="text-sm font-semibold text-neutral-900">Advisory signals</h3>
          </div>

          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-600">Match score</dt>
              <dd className="font-mono text-neutral-900">
                {detail.score ? detail.score.composite.toFixed(2) : 'None'}
                {detail.score?.overridden && (
                  <span className="ml-2 font-sans">
                    <Badge tone="warning">Overridden by a human</Badge>
                  </span>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-600">Resume parsing</dt>
              <dd className="text-neutral-900">
                {detail.resume?.parseStatus ? formatStage(detail.resume.parseStatus) : 'No resume'}
              </dd>
            </div>
          </dl>

          <p className="mt-3 max-w-[70ch] text-xs leading-relaxed text-neutral-500">
            Produced by <span className="font-medium">baseline-rules-v1</span>, a rule-based scorer
            — not a trained model. These signals rank and explain. They have not moved this
            candidate, and no automated path in TalentLens can reject anyone.
          </p>
        </section>

        {/* ---------------------------------------------------------------- */}
        <section className="p-5">
          <div className="flex items-center gap-2">
            <Badge tone="primary">Human</Badge>
            <h3 className="text-sm font-semibold text-neutral-900">Decisions taken</h3>
          </div>

          {latest ? (
            <p className="mt-3 text-sm text-neutral-700">
              Currently <span className="font-semibold">{formatStage(detail.currentStage)}</span> —
              moved by <span className="font-medium">{latest.actorEmail}</span> on{' '}
              {formatWhen(latest.changedAt)}.
            </p>
          ) : (
            <p className="mt-3 text-sm text-neutral-700">
              Currently <span className="font-semibold">{formatStage(detail.currentStage)}</span>.
              No stage change has been recorded since the application was submitted.
            </p>
          )}

          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-600">Stage changes</dt>
              <dd className="text-neutral-900">{history.length}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-600">Scorecards submitted</dt>
              <dd className="text-neutral-900">{scorecardCount ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-600">Comments</dt>
              <dd className="text-neutral-900">{commentCount ?? '—'}</dd>
            </div>
          </dl>

          <p className="mt-3 max-w-[70ch] text-xs leading-relaxed text-neutral-500">
            Every stage change is attributed to the person who made it and is recorded in the
            append-only audit log. Moving a candidate into a terminal stage requires a confirmation
            step.
          </p>
        </section>

        {/* ---------------------------------------------------------------- */}
        <div className="p-5">
          {/*
            The gap is named on screen rather than left as an empty field. A
            recruiter who expects "why was this person rejected?" to be stored
            structurally should know that it is not, and where to put it instead.
          */}
          <Notice tone="info" title="Reasons are not stored on the stage change">
            <p>
              The pipeline records <span className="font-medium">who</span> moved a candidate and{' '}
              <span className="font-medium">when</span>, but there is no field for{' '}
              <span className="font-medium">why</span> — `stage_history` has no reason column.
              Record the reasoning in the comment thread below so it stays with the application.
            </p>
            <p className="mt-1">
              A score override is the exception: it cannot be saved without a written reason
              (BR-02), and that reason is kept in the audit trail.
            </p>
          </Notice>
        </div>
      </div>
    </Card>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an unknown date';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
