import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * HM-01 — the reviewer's queue (`GET /v1/me/reviews`).
 *
 * SCOPED ENTIRELY SERVER-SIDE. The endpoint filters through `job_assignments`
 * for Hiring Managers *and* Administrators (amendment D7), and the DTO's own
 * comment notes that "the client cannot widen this scope" — there is no job or
 * user parameter to send, so this hook could not ask for someone else's queue
 * even if it tried.
 *
 * An empty queue is explicitly NOT an error (Gap 1): a reviewer with no
 * assignments simply has nothing waiting.
 */

export interface ReviewItem {
  applicationId: string;
  jobId: string;
  jobTitle: string;
  candidateName: string;
  requestedAt: string;
  /** Whether THIS reviewer has already submitted their scorecard. */
  scorecardSubmitted: boolean;
}

interface ReviewListResponse {
  data: ReviewItem[];
  nextCursor: string | null;
}

/** `ListReviewsQueryDto` — the only two values `status` accepts. */
export type ReviewStatus = 'pending' | 'completed';

export const REVIEW_PAGE_SIZE = 20;

export function useReviews(status?: ReviewStatus, cursor?: string) {
  return useQuery({
    queryKey: ['me-reviews', status ?? null, cursor ?? null],
    queryFn: ({ signal }) =>
      api.get<ReviewListResponse>('/me/reviews', {
        query: { status, cursor, limit: REVIEW_PAGE_SIZE },
        signal,
      }),
  });
}

export function formatRequestedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
