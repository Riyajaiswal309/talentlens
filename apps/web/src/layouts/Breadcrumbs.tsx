import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

/**
 * Breadcrumb labels, supplied by whichever page knows them.
 *
 * THE PROBLEM THIS SOLVES. §4.1 specifies the trail
 * `Jobs › {Job title} › Candidates › {Candidate}` — but the URL carries ids,
 * not titles, and only the page that fetched the record knows the human name.
 * The layout cannot fetch it without duplicating the page's request.
 *
 * So the trail is built from the path, and pages register the label for their
 * own id once they have it. Until a page registers one the crumb falls back to
 * a shortened id, which is honest: it shows what is actually known rather than
 * a title invented to fill the gap.
 */
type LabelMap = Readonly<Record<string, string>>;

interface BreadcrumbContextValue {
  labels: LabelMap;
  setLabel: (id: string, label: string | null) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [labels, setLabels] = useState<LabelMap>({});

  const setLabel = useCallback((id: string, label: string | null) => {
    setLabels((current) => {
      if (label === null) {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }
      // Bail out when nothing changed, so a page that re-registers the same
      // label on every render cannot loop.
      if (current[id] === label) return current;
      return { ...current, [id]: label };
    });
  }, []);

  const value = useMemo(() => ({ labels, setLabel }), [labels, setLabel]);
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>;
}

/**
 * Register the human name for an id segment.
 *
 * TODO(Step 4/5): the job list and candidate pages call this once their query
 * resolves — `useBreadcrumbLabel(jobId, job.title)` — which is what turns
 * `Jobs › 00000000…` into `Jobs › Senior Backend Engineer`.
 */
export function useBreadcrumbLabel(id: string | undefined, label: string | undefined): void {
  const context = useContext(BreadcrumbContext);
  const setLabel = context?.setLabel;

  useEffect(() => {
    if (!id || !setLabel) return;
    if (label) setLabel(id, label);
    // Cleared on unmount so a stale title cannot survive into another record's
    // trail after navigation.
    return () => setLabel(id, null);
  }, [id, label, setLabel]);
}

interface Crumb {
  label: string;
  /** Absent on the final crumb — the current page is not a link to itself. */
  to?: string;
}

/**
 * Path segments that are their own label rather than an id to look up.
 *
 * A lookup rather than a chain of comparisons: every new section adds one
 * entry, and a segment missing from here falls through to the id path and
 * surfaces as a raw URL fragment in the trail — which is how `pipeline`
 * appeared lower-cased when RC-09 was routed.
 */
const STATIC_LABELS: Record<string, string> = {
  jobs: 'Jobs',
  candidates: 'Candidates',
  pipeline: 'Pipeline',
  // Administrator section (FR8.1, FR8.3). Without these the trail renders the
  // raw path — "admin › audit" — which is a URL, not a label.
  admin: 'Administration',
  users: 'Users',
  audit: 'Audit log',
};

/**
 * Derive the trail from the current path.
 *
 * Reads the URL rather than a registry of routes, so a page cannot forget to
 * declare its crumb and silently drop out of the trail.
 */
function useTrail(): Crumb[] {
  const { pathname } = useLocation();
  const labels = useContext(BreadcrumbContext)?.labels ?? {};

  return useMemo(() => {
    const segments = pathname.split('/').filter(Boolean);
    const crumbs: Crumb[] = [];

    segments.forEach((segment, index) => {
      const to = `/${segments.slice(0, index + 1).join('/')}`;
      const isLast = index === segments.length - 1;

      // Static segments are their own label; id segments look one up.
      const known = labels[segment];
      const label = STATIC_LABELS[segment] ?? known ?? shortenId(segment);

      crumbs.push(isLast ? { label } : { label, to });
    });

    return crumbs;
  }, [pathname, labels]);
}

/** A uuid is unreadable in a trail; its first block is enough to recognise. */
function shortenId(value: string): string {
  const [head] = value.split('-');
  return head && head.length >= 8 ? head : value;
}

export function Breadcrumbs() {
  const trail = useTrail();

  // A single crumb is the section root — the trail would say nothing the page
  // title does not already say.
  if (trail.length < 2) return null;

  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-700">
        {trail.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex items-center gap-x-2">
            {index > 0 && (
              // Decorative: the list structure already conveys the nesting to
              // assistive technology, so the separator must not be read out.
              <span aria-hidden="true" className="text-neutral-300">
                ›
              </span>
            )}
            {crumb.to ? (
              <Link to={crumb.to} className="rounded-sm text-primary-700 hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-semibold text-neutral-900">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
