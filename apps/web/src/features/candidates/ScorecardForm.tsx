import { useId, useState, type FormEvent } from 'react';
import { ErrorState } from '../../components/ErrorState';
import { isApiError } from '../../lib/problem-details';
import {
  MAX_FEEDBACK_LENGTH,
  MAX_RATING,
  MIN_RATING,
  useAddScorecard,
  type ScorecardInput,
} from './useScorecardMutation';

/**
 * RC-13 — submit a scorecard (FR5.3, Table 5.1 "Rating control, feedback text").
 *
 * A RADIO GROUP, NOT A NUMBER INPUT. The scale is a fixed 1–5, so a group of
 * five radios makes an invalid rating unrepresentable rather than merely
 * rejected — no parsing, no spinner arrows past the bound, and it is keyboard
 * operable by construction (NFR4). The numeric value is in the label too,
 * because §10.3 forbids conveying a rating by position alone.
 *
 * THE FORM STAYS USABLE AFTER A 409. One scorecard per author is a database
 * constraint, so a duplicate is an ordinary outcome rather than a fault: the
 * message is shown, the typed feedback is kept, and the author's existing entry
 * appears in the list above (the mutation invalidates it).
 */
export function ScorecardForm({ applicationId }: { applicationId: string | undefined }) {
  const submit = useAddScorecard(applicationId);

  const [rating, setRating] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const groupId = useId();
  const feedbackId = useId();
  const errorId = `${groupId}-error`;

  const tooLong = feedback.length > MAX_FEEDBACK_LENGTH;
  const alreadySubmitted = isApiError(submit.error) && submit.error.status === 409;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);

    // Checked here so an unrated submit is a field message rather than a 400.
    if (rating === null) {
      setLocalError('Choose a rating before submitting.');
      return;
    }
    if (tooLong) {
      setLocalError(
        `Feedback must be ${MAX_FEEDBACK_LENGTH.toLocaleString()} characters or fewer.`,
      );
      return;
    }

    /*
     * `feedback` is omitted when blank rather than sent as `''`. The column is
     * nullable and a rating alone is a valid scorecard; an empty string would
     * store "they wrote nothing" as if it were written.
     */
    const trimmed = feedback.trim();
    const input: ScorecardInput = { rating, ...(trimmed ? { feedback: trimmed } : {}) };

    submit.mutate(input, {
      // Cleared only once the server has accepted it, so a failed submission
      // never loses what was typed.
      onSuccess: () => {
        setRating(null);
        setFeedback('');
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="mt-4 border-t border-neutral-300 pt-4">
      <fieldset>
        {/* A legend, not a floating label — the five radios are one control. */}
        <legend className="mb-1 text-sm font-semibold text-neutral-900">
          Your rating <span className="font-normal text-neutral-500">(Required)</span>
        </legend>
        {/*
          No `role="radiogroup"` and no aria-labelledby: native radios sharing a
          `name` inside a fieldset are already a group, and the legend already
          names it. Adding ARIA here would only risk pointing at an id that does
          not exist.
        */}
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: MAX_RATING - MIN_RATING + 1 }, (_, index) => {
            const value = MIN_RATING + index;
            const checked = rating === value;
            return (
              <label key={value} className="cursor-pointer">
                <input
                  type="radio"
                  name={groupId}
                  value={value}
                  checked={checked}
                  onChange={() => {
                    setRating(value);
                    setLocalError(null);
                  }}
                  /*
                   * Visually replaced by the span below, but still the real
                   * control — arrow keys, `name` grouping and screen-reader
                   * semantics all stay native. `peer` lets the span pick up its
                   * focus state, which is what keeps the ring visible.
                   */
                  className="peer sr-only"
                />
                {/*
                  THE FOCUS RING IS ON THIS SPAN, not the input. A visually
                  hidden input still takes focus, so without
                  `peer-focus-visible` a keyboard user would move through the
                  ratings with nothing on screen changing — WCAG 2.4.7, which
                  NFR4 commits the project to.
                */}
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-sm border text-sm font-semibold peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary-700 ${
                    checked
                      ? // §8.2 — the primary ramp. A rating is not a verdict the
                        // system makes, so no success/danger colouring (BR-01).
                        'border-primary-700 bg-primary-50 text-primary-700'
                      : 'border-neutral-300 bg-neutral-0 text-neutral-900 hover:bg-neutral-100'
                  }`}
                >
                  {value}
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {MIN_RATING} is the weakest, {MAX_RATING} the strongest.
        </p>
      </fieldset>

      <div className="mt-3">
        <label htmlFor={feedbackId} className="mb-1 block text-sm font-semibold text-neutral-900">
          Feedback <span className="font-normal text-neutral-500">(Optional)</span>
        </label>
        <textarea
          id={feedbackId}
          rows={3}
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          maxLength={MAX_FEEDBACK_LENGTH}
          aria-invalid={tooLong ? true : undefined}
          className={`w-full rounded-sm border px-3 py-2 text-sm text-neutral-900 ${
            tooLong ? 'border-danger-700' : 'border-neutral-300'
          }`}
        />
        <p className="mt-1 text-xs text-neutral-500">
          {feedback.length} of {MAX_FEEDBACK_LENGTH.toLocaleString()} characters. Visible to the
          hiring team.
        </p>
      </div>

      {localError && (
        <p id={errorId} role="alert" className="mt-2 text-sm text-danger-700">
          {localError}
        </p>
      )}

      {/*
        A 409 is not a failure of the request — it is the one-per-author rule
        doing its job — so it is stated plainly rather than dressed as an error
        panel. Anything else goes through ErrorState with the server's sentence.
      */}
      {alreadySubmitted ? (
        <p role="alert" className="mt-2 text-sm text-warning-700">
          {isApiError(submit.error) ? submit.error.problem.detail : ''} Yours is shown above.
        </p>
      ) : (
        submit.error != null && (
          <div className="mt-2">
            <ErrorState error={submit.error} title="Your scorecard was not submitted" />
          </div>
        )
      )}

      <button
        type="submit"
        disabled={submit.isPending || rating === null || tooLong}
        aria-disabled={submit.isPending || rating === null || tooLong}
        className="mt-3 h-10 rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 hover:bg-primary-600 disabled:opacity-40"
      >
        {submit.isPending ? 'Submitting…' : 'Submit scorecard'}
      </button>
    </form>
  );
}
