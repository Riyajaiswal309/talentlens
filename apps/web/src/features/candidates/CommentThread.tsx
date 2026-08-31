import { useId, useState, type FormEvent } from 'react';
import { ErrorState } from '../../components/ErrorState';
import { SkeletonText } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import {
  formatRole,
  MAX_COMMENT_LENGTH,
  useAddComment,
  type CommentResponse,
} from './useApplication';

/**
 * The comment thread and composer (§7.3 footer; FR5.3).
 *
 * VISIBLE TO THE WHOLE HIRING TEAM, AND ONLY TO IT. The endpoint admits
 * Recruiter, Hiring Manager and Admin; a candidate cannot reach it at all,
 * because a comment is the team talking *about* them, not to them.
 */
export function CommentThread({
  applicationId,
  query,
}: {
  applicationId: string | undefined;
  query: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    data: CommentResponse[] | undefined;
    refetch: () => void;
  };
}) {
  const { notify } = useToast();
  const add = useAddComment(applicationId);
  const [body, setBody] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;

  const tooLong = body.length > MAX_COMMENT_LENGTH;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);

    /*
     * `@Matches(/\S/)` on the DTO: whitespace is not a comment. Checked here so
     * an accidental space-only submit is a field message rather than a 400.
     */
    if (!body.trim()) {
      setLocalError('Write something before posting.');
      return;
    }
    if (tooLong) {
      setLocalError(`A comment must be ${MAX_COMMENT_LENGTH} characters or fewer.`);
      return;
    }

    // The box is cleared only after the server accepts it, so a failed post
    // does not lose what was typed.
    add.mutate(body, {
      onSuccess: () => {
        setBody('');
        notify('Comment posted.');
      },
    });
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-neutral-0 shadow-card p-4">
      <h2 className="text-base font-semibold text-neutral-900">Comments</h2>

      {query.isPending && (
        <div className="mt-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading comments…</span>
          <SkeletonText lines={3} />
        </div>
      )}

      {query.isError && (
        <div className="mt-3">
          <ErrorState
            error={query.error}
            title="Comments could not be loaded"
            onRetry={() => query.refetch()}
          />
        </div>
      )}

      {!query.isPending && !query.isError && (query.data?.length ?? 0) === 0 && (
        <p className="mt-2 text-sm text-neutral-500">
          No comments yet. Anything you post here is visible to the whole hiring team.
        </p>
      )}

      {query.data && query.data.length > 0 && (
        // Oldest first, as the server returns them (`createdAt asc`) — a thread
        // reads forwards.
        <ul className="mt-3 space-y-3">
          {query.data.map((comment) => (
            <li
              key={comment.id}
              className="border-t border-neutral-200 pt-3 first:border-0 first:pt-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-neutral-900">{comment.author.email}</p>
                <p className="text-xs text-neutral-500">
                  {formatRole(comment.author.role)} · {formatDateTime(comment.createdAt)}
                </p>
              </div>
              {/* `whitespace-pre-line` keeps the author's line breaks. */}
              <p className="mt-1 max-w-[70ch] whitespace-pre-line text-sm text-neutral-700">
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} noValidate className="mt-4 border-t border-neutral-200 pt-4">
        <label htmlFor={fieldId} className="mb-1 block text-sm font-semibold text-neutral-900">
          Add a comment
        </label>
        <textarea
          id={fieldId}
          rows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-invalid={localError || tooLong ? true : undefined}
          aria-describedby={localError ? errorId : undefined}
          className={`w-full rounded-sm border px-3 py-2 text-sm text-neutral-900 ${
            localError || tooLong ? 'border-danger-700' : 'border-neutral-300'
          }`}
        />
        <p className="mt-1 text-xs text-neutral-500">
          {body.length} of {MAX_COMMENT_LENGTH.toLocaleString()} characters. Visible to the hiring
          team.
        </p>

        {localError && (
          <p id={errorId} role="alert" className="mt-1 text-sm text-danger-700">
            {localError}
          </p>
        )}

        {/* A rejected post shows the server's own sentence (§23.1). */}
        {add.error != null && (
          <div className="mt-2">
            <ErrorState error={add.error} title="Your comment was not posted" />
          </div>
        )}

        <button
          type="submit"
          disabled={add.isPending || !body.trim() || tooLong}
          aria-disabled={add.isPending || !body.trim() || tooLong}
          className="mt-3 h-10 rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 shadow-sm transition-colors hover:bg-primary-800 disabled:opacity-40"
        >
          {add.isPending ? 'Posting…' : 'Post comment'}
        </button>
      </form>
    </section>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
