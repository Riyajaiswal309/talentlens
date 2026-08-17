import type { ReactNode } from 'react';

/**
 * "There is nothing here" — a legitimate answer, not a failure.
 *
 * TABLE 5.1 DISTINGUISHES TWO EMPTIES and so does this component, through
 * `variant`. RC-02 lists "empty; filtered-empty" separately because they need
 * opposite actions: an account with no jobs should be invited to create one,
 * while a filter that matched nothing should be invited to clear the filter.
 * Offering "Create job" to someone whose filter is simply too narrow sends
 * them to author a duplicate of a job they already have.
 */
export function EmptyState({
  title,
  description,
  action,
  variant = 'empty',
}: {
  title: string;
  description?: string;
  /** The single next step. Omit when there is honestly nothing to offer. */
  action?: ReactNode;
  variant?: 'empty' | 'filtered';
}) {
  return (
    <div className="rounded-md border border-neutral-300 bg-neutral-0 px-6 py-12 text-center">
      <p aria-hidden="true" className="text-2xl text-neutral-300">
        {variant === 'filtered' ? '⌕' : '—'}
      </p>
      {/*
        h2, not h1: an empty state always sits inside a page that already has
        a title, and restarting the heading order would break the outline a
        screen-reader user navigates by (NFR4).
      */}
      <h2 className="mt-3 text-base font-semibold text-neutral-900">{title}</h2>
      {description && (
        <p className="mx-auto mt-1 max-w-md text-sm text-neutral-700">{description}</p>
      )}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}
