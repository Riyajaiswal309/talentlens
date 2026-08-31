import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ErrorState } from '../../components/ErrorState';
import { useToast } from '../../components/Toast';
import { Card, CardHeader, buttonClass } from '../../components/ui';
import { api } from '../../lib/api-client';
import type { WireScore } from './useJobCandidates';

/** `OverrideScoreDto` — anything outside these bounds is a 400. */
const MIN_SCORE = 0;
const MAX_SCORE = 1;
const MAX_REASON_LENGTH = 2000;

interface OverrideResult {
  applicationId: string;
  matchScoreId: string;
  overridden: true;
  overriddenBy: string;
  /** PRD §15.4 — the override does not replace the AI value; both remain. */
  originalScore: number;
  overrideScore: number;
  reason: string;
}

function useOverrideScore(applicationId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { overrideScore: number; reason: string }) =>
      api.patch<OverrideResult>(`/applications/${applicationId!}/score`, input),
    onSuccess: () => {
      // The score is embedded in the application record and in the job's
      // candidate list, so both must be refetched or the old value lingers.
      void queryClient.invalidateQueries({ queryKey: ['application', applicationId] });
      void queryClient.invalidateQueries({ queryKey: ['job-candidates'] });
    },
  });
}

/**
 * FR4.3 — "Recruiters can manually override any AI-generated rank or score,
 * supplying a reason."
 *
 * A REASON IS MANDATORY, not a nicety: BR-03 requires every override to be
 * audited with one, `OverrideScoreDto` marks `reason` required, and the server
 * writes the audit row before the response returns. The form therefore refuses
 * to submit without it rather than letting the server reject the attempt.
 *
 * THE ORIGINAL SCORE SURVIVES. §15.4 keeps both values — the response returns
 * `originalScore` alongside `overrideScore`, and the panel shows both, so the
 * override reads as a recorded human judgement rather than as a correction that
 * erased what the system said.
 *
 * RENDERED ONLY WHEN A SCORE EXISTS. `PATCH /v1/applications/:id/score` needs a
 * `match_scores` row to override; with no model running there are none in this
 * build, so the control is absent rather than present-and-guaranteed-to-fail.
 * The caller decides — see `ScorePanel`.
 */
export function ScoreOverrideForm({
  applicationId,
  score,
}: {
  applicationId: string | undefined;
  score: WireScore;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>(score.composite.toFixed(2));
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const { notify } = useToast();

  const override = useOverrideScore(applicationId);
  const scoreId = useId();
  const reasonId = useId();
  const scoreErrorId = `${scoreId}-error`;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);

    const parsed = Number(value);
    if (Number.isNaN(parsed) || parsed < MIN_SCORE || parsed > MAX_SCORE) {
      setFieldError(`Score must be a number between ${MIN_SCORE} and ${MAX_SCORE}`);
      return;
    }
    // Mirrors the DTO so a missing reason never becomes a round trip whose
    // error reads as a rejected override rather than an unfinished form.
    if (!reason.trim()) {
      setFieldError('A reason is required to override a score');
      return;
    }

    override.mutate(
      { overrideScore: parsed, reason: reason.trim() },
      {
        onSuccess: (result) => {
          notify(`Score overridden to ${result.overrideScore.toFixed(2)}.`);
          setOpen(false);
          setReason('');
        },
      },
    );
  }

  if (!open) {
    return (
      <div className="mt-4 border-t border-neutral-200 pt-4">
        <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary')}>
          Override this score
        </button>
        <p className="mt-2 text-xs text-neutral-500">
          The original score is kept alongside your override, and the change is recorded in the
          audit log with your reason.
        </p>
      </div>
    );
  }

  return (
    <Card className="mt-4">
      <CardHeader
        title="Override score"
        description="Both values are kept — this does not erase the original."
      />
      <form onSubmit={handleSubmit} noValidate className="p-5">
        <div className="mb-4">
          <label htmlFor={scoreId} className="mb-1.5 block text-sm font-semibold text-neutral-900">
            New score <span className="font-normal text-neutral-500">(0 to 1, required)</span>
          </label>
          <input
            id={scoreId}
            type="number"
            min={MIN_SCORE}
            max={MAX_SCORE}
            step={0.01}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? scoreErrorId : undefined}
            className="h-10 w-32 rounded-md border border-neutral-300 px-3 text-right font-mono text-sm text-neutral-900"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Original score {score.composite.toFixed(2)} from {score.modelVersion}.
          </p>
        </div>

        <div className="mb-4">
          <label htmlFor={reasonId} className="mb-1.5 block text-sm font-semibold text-neutral-900">
            Reason <span className="font-normal text-neutral-500">(required)</span>
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={MAX_REASON_LENGTH}
            className="w-full rounded-md border border-neutral-300 p-3 text-sm text-neutral-900"
          />
          <p className="mt-1 text-xs text-neutral-500">
            {reason.length} of {MAX_REASON_LENGTH.toLocaleString()} characters. BR-03 — every
            override is audited with its reason.
          </p>
        </div>

        {fieldError && (
          <p id={scoreErrorId} role="alert" className="mb-4 text-sm text-danger-700">
            {fieldError}
          </p>
        )}

        {override.error != null && (
          <div className="mb-4">
            <ErrorState error={override.error} title="The override was not applied" />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={override.isPending}
            aria-disabled={override.isPending}
            className={buttonClass('primary')}
          >
            {override.isPending ? 'Saving…' : 'Save override'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setFieldError(null);
            }}
            className={buttonClass('secondary')}
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
