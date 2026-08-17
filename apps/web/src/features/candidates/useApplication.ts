import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client';
import type { WireScore } from './useJobCandidates';

/**
 * `ApplicationDetailResponse` from `applications.controller.ts`.
 *
 * WHAT IS NOT IN IT, and therefore not on the screen: no parsed profile (work
 * history, education, certifications), and no stage history. `ParsedProfile` and
 * `StageHistory` exist in the schema but no controller exposes either for a
 * recruiter reading one application — so §7.3's left column and activity
 * timeline have no source, and are absent rather than stubbed.
 *
 * `score` and `source` are always null for a CANDIDATE caller (§24.2). This app
 * is Recruiter/Admin only, so a null here means "no score exists" rather than
 * "withheld from you".
 */
export interface ApplicationDetailResponse {
  id: string;
  /** First 8 characters of the id, upper-cased — the server derives it. */
  reference: string;
  currentStage: string;
  appliedAt: string;
  job: {
    id: string;
    title: string;
    department: string | null;
    location: string | null;
    employmentType: string | null;
    status: string;
  };
  candidate: {
    fullName: string;
    email: string;
    phone: string | null;
  };
  /**
   * Metadata only. The controller deliberately withholds `s3_key`: handing it
   * out would let a caller address the bucket directly, and serving the file is
   * a separate concern nothing has specified.
   */
  resume: {
    /** FR2.5 — always `PENDING` in Phase 2; no parser runs. */
    parseStatus: string;
    mimeType: string;
    uploadedAt: string;
  } | null;
  score: WireScore | null;
  /** FR7.3 — the channel this application arrived through. */
  source: string | null;
}

/** `ScorecardResponse`. Rating is a whole number 1–5 (`create-scorecard.dto`). */
export interface ScorecardResponse {
  id: string;
  rating: number;
  feedback: string | null;
  author: { id: string; email: string; role: string };
  submittedAt: string;
}

/** `CommentResponse`. */
export interface CommentResponse {
  id: string;
  body: string;
  author: { id: string; email: string; role: string };
  createdAt: string;
}

/** `InterviewResponse` from `interviews.controller.ts`. */
export interface InterviewResponse {
  id: string;
  applicationId: string;
  jobId: string;
  jobTitle: string;
  /** `PENDING_SELECTION` | `SCHEDULED` | `CANCELLED`. */
  status: string;
  scheduledAt: string | null;
  timezone: string | null;
  /** Null whenever the interview was arranged without a provider (FR6.3). */
  calendarEventId: string | null;
  interviewers: { id: string; email: string }[];
  slots: { slotId: string; startsAt: string; endsAt: string; timezone: string }[];
  selectedSlotId: string | null;
  createdAt: string;
}

/** `CreateCommentDto` — non-whitespace, at most 5000 characters. */
export const MAX_COMMENT_LENGTH = 5000;

export function useApplication(applicationId: string | undefined) {
  return useQuery({
    queryKey: ['application', applicationId ?? null],
    queryFn: ({ signal }) =>
      api.get<ApplicationDetailResponse>(`/applications/${applicationId!}`, { signal }),
    enabled: Boolean(applicationId),
  });
}

/*
 * The three sub-resources are separate queries, not one aggregate.
 *
 * Each has its own endpoint and its own failure: a comment thread that fails to
 * load must not blank the candidate's name, and scorecards being empty says
 * nothing about whether interviews exist. Separate queries let each panel show
 * its own state, which is what §7.3's three-region layout implies.
 *
 * None of them paginates — all three return a plain `{ data: [...] }`.
 */

export function useScorecards(applicationId: string | undefined) {
  return useQuery({
    queryKey: ['application-scorecards', applicationId ?? null],
    queryFn: ({ signal }) =>
      api
        .get<{ data: ScorecardResponse[] }>(`/applications/${applicationId!}/scorecards`, {
          signal,
        })
        .then((response) => response.data),
    enabled: Boolean(applicationId),
  });
}

export function useComments(applicationId: string | undefined) {
  return useQuery({
    queryKey: ['application-comments', applicationId ?? null],
    queryFn: ({ signal }) =>
      api
        .get<{ data: CommentResponse[] }>(`/applications/${applicationId!}/comments`, { signal })
        // Server order is `createdAt asc` — oldest first, which is how a thread
        // reads. Preserved rather than reversed.
        .then((response) => response.data),
    enabled: Boolean(applicationId),
  });
}

export function useApplicationInterviews(applicationId: string | undefined) {
  return useQuery({
    queryKey: ['application-interviews', applicationId ?? null],
    queryFn: ({ signal }) =>
      api
        .get<{ data: InterviewResponse[] }>(`/applications/${applicationId!}/interviews`, {
          signal,
        })
        .then((response) => response.data),
    enabled: Boolean(applicationId),
  });
}

/**
 * POST a comment (FR5.3). Returns 201 with the created comment.
 *
 * Invalidates rather than appending to the cache: the server assigns the id and
 * timestamp, and refetching is the only way the thread reflects what anyone
 * else posted in the meantime.
 */
export function useAddComment(applicationId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: string) =>
      api.post<CommentResponse>(`/applications/${applicationId!}/comments`, { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['application-comments', applicationId ?? null],
      });
    },
  });
}

/** §24.2 role constants are not display text. */
export function formatRole(role: string): string {
  if (!role) return '';
  return role
    .toLowerCase()
    .split('_')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}
