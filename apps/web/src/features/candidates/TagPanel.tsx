import { useId, useState, type FormEvent } from 'react';
import { ErrorState } from '../../components/ErrorState';
import { SkeletonText } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { Card, CardHeader, buttonClass } from '../../components/ui';
import { CloseIcon } from '../../components/icons';
import { isApiError } from '../../lib/problem-details';
import { MAX_TAG_LENGTH, useAddTag, useRemoveTag, useTags } from './useTags';

/**
 * FR5.2 — tags on one application.
 *
 * INTERNAL TO THE HIRING TEAM, which the copy states rather than leaving
 * implicit: a recruiter typing "needs visa sponsorship" should know the
 * candidate cannot see it. The API enforces that by omitting CANDIDATE from
 * every tag route; this panel only says so.
 *
 * DUPLICATES ARE THE SERVER'S CALL. The database holds a case-insensitive
 * unique index, so "Python" and "python" collide there and return 409. The
 * form surfaces that message rather than pre-checking the loaded list, because
 * a check against a stale list would still lose a race.
 */
export function TagPanel({ applicationId }: { applicationId: string | undefined }) {
  const [label, setLabel] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const { notify } = useToast();

  const query = useTags(applicationId);
  const addTag = useAddTag(applicationId);
  const removeTag = useRemoveTag(applicationId);

  const inputId = useId();
  const errorId = `${inputId}-error`;
  const tags = query.data?.data ?? [];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);

    const trimmed = label.trim().replace(/\s+/g, ' ');
    if (!trimmed) {
      setFieldError('Enter a tag');
      return;
    }
    if (trimmed.length > MAX_TAG_LENGTH) {
      setFieldError(`A tag must be ${MAX_TAG_LENGTH} characters or fewer`);
      return;
    }

    addTag.mutate(trimmed, {
      // Cleared only once the server accepted it, so a rejected tag is not lost
      // from the field the moment it fails.
      onSuccess: () => {
        setLabel('');
        notify(`Tagged “${trimmed}”.`);
      },
    });
  }

  function onRemove(id: string, tagLabel: string) {
    removeTag.mutate(id, { onSuccess: () => notify(`Removed “${tagLabel}”.`) });
  }

  return (
    <Card>
      <CardHeader
        title="Tags"
        description="Shorthand for your hiring team. Not visible to the candidate."
      />
      <div className="p-5">
        {query.isPending ? (
          <div role="status" aria-live="polite" aria-busy="true">
            <span className="sr-only">Loading tags…</span>
            <SkeletonText lines={1} />
          </div>
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : tags.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No tags yet. Add one to group this candidate with others.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <li key={tag.id}>
                {/*
                  The chip is not itself a button — the remove control is, so
                  the label stays selectable text and the action has its own
                  accessible name rather than "×".
                */}
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-50 py-1 pl-3 pr-1.5 text-sm font-medium text-primary-700 ring-1 ring-inset ring-primary-200">
                  <span title={`Added by ${tag.createdByEmail}`}>{tag.label}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(tag.id, tag.label)}
                    disabled={removeTag.isPending}
                    aria-disabled={removeTag.isPending}
                    aria-label={`Remove tag ${tag.label}`}
                    className="rounded-full p-0.5 text-primary-700 transition-colors hover:bg-primary-100 disabled:opacity-40"
                  >
                    <CloseIcon className="h-3.5 w-3.5" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleSubmit} noValidate className="mt-4 border-t border-neutral-200 pt-4">
          <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-neutral-900">
            Add a tag
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={inputId}
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={MAX_TAG_LENGTH}
              placeholder="e.g. Strong communicator"
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? errorId : undefined}
              className={`h-10 min-w-0 flex-1 rounded-md border px-3 text-sm text-neutral-900 transition-colors ${
                fieldError ? 'border-danger-700' : 'border-neutral-300 hover:border-neutral-400'
              }`}
            />
            <button
              type="submit"
              disabled={addTag.isPending}
              aria-disabled={addTag.isPending}
              className={buttonClass('secondary')}
            >
              {addTag.isPending ? 'Adding…' : 'Add'}
            </button>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            {label.length} of {MAX_TAG_LENGTH} characters.
          </p>

          {fieldError && (
            <p id={errorId} role="alert" className="mt-1 text-sm text-danger-700">
              {fieldError}
            </p>
          )}

          {addTag.error != null && (
            <div className="mt-3">
              <ErrorState
                error={addTag.error}
                // 409 is the duplicate case and has its own sentence from the
                // server; anything else is a genuine failure to add.
                title={
                  isApiError(addTag.error) && addTag.error.status === 409
                    ? 'That tag is already on this application'
                    : 'The tag was not added'
                }
              />
            </div>
          )}

          {removeTag.error != null && (
            <div className="mt-3">
              <ErrorState error={removeTag.error} title="The tag was not removed" />
            </div>
          )}
        </form>
      </div>
    </Card>
  );
}
