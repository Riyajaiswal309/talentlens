import type { ReactNode } from 'react';

/**
 * Loading placeholders (Phase 1 Table 5.1 — RC-01, RC-02 and RC-05 all name a
 * "loading skeleton" as a required state).
 *
 * WHY SKELETONS RATHER THAN A SPINNER. A spinner says "something is happening";
 * a skeleton says "a table is arriving and it will be about this big", so the
 * layout does not jump when data lands. That matters most on RC-05, where a
 * shifting list moves the row a recruiter was about to click.
 */

/** One grey bar. Never used alone — compose the shapes below. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    /*
     * aria-hidden throughout: these are decorative stand-ins, and a screen
     * reader announcing a dozen empty boxes is worse than silence. The single
     * spoken announcement comes from `LoadingState` below.
     */
    <div aria-hidden="true" className={`animate-pulse rounded-sm bg-neutral-100 ${className}`} />
  );
}

/** Stacked lines, sized to body text (14px with a 22px line box). */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          // The last line runs short, the way a real paragraph does.
          className={`h-[14px] ${index === lines - 1 ? 'w-2/3' : 'w-full'}`}
        />
      ))}
    </div>
  );
}

/** A table's shape while its rows are in flight. */
export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-md border border-neutral-300 bg-neutral-0">
      <div className="flex gap-4 border-b border-neutral-300 bg-neutral-100 px-4 py-3">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className="h-[14px] flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="flex gap-4 border-b border-neutral-300 px-4 py-4 last:border-0"
        >
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton key={columnIndex} className="h-[14px] flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The announced wrapper around any loading placeholder.
 *
 * ONE LIVE REGION PER LOADING AREA. `role="status"` with `aria-live="polite"`
 * tells a screen-reader user that a wait is in progress without interrupting
 * them, which the silent skeletons cannot do on their own (NFR4, WCAG 2.1 AA).
 */
export function LoadingState({
  label = 'Loading…',
  children,
}: {
  label?: string;
  children?: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      {/* Announced, not drawn — the visual signal is the skeleton itself. */}
      <span className="sr-only">{label}</span>
      {children ?? <SkeletonTable />}
    </div>
  );
}
