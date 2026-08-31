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
/**
 * FR3.1 — extracted contact fields. Every one is optional because an absent
 * field must stay absent; the parser never invents a value.
 */
export interface ParsedContactView {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
}

/**
 * FR3.2 — the parsed profile as RC-06 reads it.
 *
 * `fieldConfidence` values are RULE-BASED EXTRACTION STRENGTH, not model
 * probabilities: nothing here is trained or calibrated. The UI must say so
 * wherever it shows a number — see `PARSE_REVIEW_THRESHOLD`.
 */
export interface ParsedProfileView {
  contact: ParsedContactView | null;
  skills: string[] | null;
  fieldConfidence: Record<string, number> | null;
  confidenceScore: number | null;
  /** Provenance, e.g. `rule-based-local` / `v1`. Never a model name. */
  parserName: string | null;
  parserVersion: string | null;
}

/**
 * The server flags anything below this for human review (`ParseReviewService`).
 * Mirrored here so the UI marks the same fields the review queue would.
 */
export const PARSE_REVIEW_THRESHOLD = 0.75;

/**
 * FR5.4 — one recorded stage transition.
 *
 * `fromStage` is null only where the API says so; the FIRST stage has no entry
 * at all, because a row is written on transition and creation is not one.
 */
export interface StageHistoryEntry {
  fromStage: string | null;
  toStage: string;
  changedAt: string;
  /** Denormalised on the server — no internal user id is exposed. */
  actorEmail: string;
}

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
    /** PENDING → PROCESSING → COMPLETED | FAILED (FR2.5, FR3.2). */
    parseStatus: string;
    mimeType: string;
    uploadedAt: string;
    /**
     * FR3.1 / FR3.2 — what the parser read.
     *
     * NULL IS NOT AN EMPTY PROFILE: null means no parse has completed, while a
     * profile whose fields are all null means the parse ran and could read
     * nothing. RC-06 words those two differently.
     */
    parsedProfile: ParsedProfileView | null;
  } | null;
  /**
   * FR5.4 — the transitions this application has been through, oldest first.
   * NULL for a CANDIDATE caller, like `score` and `source`.
   */
  stageHistory: StageHistoryEntry[] | null;
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
