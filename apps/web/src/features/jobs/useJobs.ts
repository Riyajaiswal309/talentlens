import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api-client';

/**
 * `JobResponse` from `apps/api/src/modules/jobs/jobs.controller.ts`.
 *
 * Hand-mirrored, because §23.1's "DTOs generated from the OpenAPI spec" step
 * (M2.4) has not landed and the published spec declares no response schemas —
 * `GET /v1/jobs` documents its 200 with no body type at all. So this is copied
 * from the controller's own interface rather than inferred from a sample
 * payload, which would have silently missed every nullable field.
 */
export interface JobResponse {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employmentType: string | null;
  experienceLevel: string | null;
  description: string | null;
  /** `unknown` on the wire — a Prisma Json column. Narrow with `toSkills`. */
  requiredSkills: unknown;
  status: string;
  /** Read-only here: only an Administrator may change it (FR1.4, BR-04). */
  aiScoringEnabled: boolean;
  publishedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The list envelope. `nextCursor` is the id of the LAST ROW on this page, or
 * null when there is no further page (`jobs.service.ts` fetches `limit + 1` to
 * decide without a second count query).
 *
 * FORWARD ONLY — there is no `prevCursor`, so "Previous" cannot be asked of
 * the API and has to be remembered by the caller. See `useJobsPagination`.
 */
export interface JobListResponse {
  data: JobResponse[];
  nextCursor: string | null;
}

/**
 * The three job states, from `enum JobStatus` in `schema.prisma`.
 *
 * Exactly these three. The filter offers no other value because the API would
 * reject one with a 400 — `ListJobsQueryDto` validates with `@IsEnum`.
 */
export const JOB_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Matches `DEFAULT_PAGE_SIZE`'s intent while staying inside the 1–100 bound. */
export const PAGE_SIZE = 20;

export interface JobFilters {
  status?: JobStatus;
  /**
   * Free text, not an enum: `jobs.department` is a nullable string column and
   * no endpoint enumerates the values in use. A dropdown here would have to
   * invent its own options, so the filter is an input.
   */
  department?: string;
}

export function useJobs(filters: JobFilters, cursor?: string) {
  return useQuery({
    // Cursor is part of the key: each page is its own cache entry, so paging
    // back is instant rather than a refetch.
    queryKey: ['jobs', filters.status ?? null, filters.department ?? null, cursor ?? null],
    queryFn: ({ signal }) =>
      api.get<JobListResponse>('/jobs', {
        query: {
          status: filters.status,
          department: filters.department,
          cursor,
          limit: PAGE_SIZE,
        },
        signal,
      }),
    /*
     * Keeps the previous page on screen while the next one loads, so paging
     * does not collapse the table to a skeleton and back. The page marks
     * itself busy during that window instead (Table 5.1's loading state).
     */
    placeholderData: keepPreviousData,
  });
}

/**
 * One job (RC-04), from `GET /v1/jobs/:id`.
 *
 * Shares the `JobResponse` shape with the list, so a job already listed is
 * usually served from cache before its request returns.
 *
 * A 404 here covers two cases the API deliberately does not distinguish: the
 * job does not exist, or it belongs to another tenant (BR-06). `ErrorState`
 * already words that correctly.
 */
export function useJob(jobId: string | undefined) {
  return useQuery({
    queryKey: ['job', jobId ?? null],
    queryFn: ({ signal }) => api.get<JobResponse>(`/jobs/${jobId!}`, { signal }),
    enabled: Boolean(jobId),
  });
}

/**
 * Forward-only cursor paging, with the history the API does not provide.
 *
 * The server can only answer "what comes after this row", so going back means
 * remembering the cursor each page was fetched with. A stack is the whole
 * mechanism: push on next, pop on previous.
 */
export function useJobsPagination(filters: JobFilters) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<string[]>([]);

  /*
   * A filter change invalidates the entire pagination position: cursor
   * `abc` means "after the row abc IN THIS ORDERING", and a different filter
   * is a different result set where that row may not appear at all. Resetting
   * is the only correct response — carrying the cursor over would silently
   * skip rows.
   */
  useEffect(() => {
    setCursor(undefined);
    setHistory([]);
  }, [filters.status, filters.department]);

  return {
    cursor,
    pageNumber: history.length + 1,
    canGoBack: history.length > 0,
    goNext: (nextCursor: string) => {
      setHistory((stack) => [...stack, ...(cursor ? [cursor] : [''])]);
      setCursor(nextCursor);
    },
    goBack: () => {
      setHistory((stack) => {
        const previous = stack[stack.length - 1];
        // An empty string marks page one, which is fetched with no cursor.
        setCursor(previous ? previous : undefined);
        return stack.slice(0, -1);
      });
    },
  };
}

/** `requiredSkills` is Json on the wire; keep only what is actually a string. */
export function toSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** Delay a rapidly-changing value so typing does not fire a request per key. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
