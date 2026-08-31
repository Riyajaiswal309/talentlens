import { useMutation, useQuery } from '@tanstack/react-query';
import { api, apiUpload } from '../../lib/api-client';

/**
 * The public careers surface (FR2.1, FR2.4).
 *
 * UNAUTHENTICATED BY DESIGN. `GET /v1/public/jobs`, `GET /v1/public/jobs/:id`
 * and `POST /v1/applications` are all `@Public()`. Nothing here sends a token,
 * and nothing here may ever read a tenant-scoped endpoint — a candidate has no
 * session, and adding an authenticated call would either fail or leak.
 */

export interface PublicJob {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employmentType: string | null;
  experienceLevel: string | null;
  description: string | null;
  requiredSkills: unknown;
  status: string;
  publishedAt: string | null;
  closedAt: string | null;
}

interface PublicJobListResponse {
  data: PublicJob[];
  nextCursor: string | null;
}

/** `ListPublicJobsQueryDto` bounds this at 1–100. */
export const PUBLIC_PAGE_SIZE = 20;

/**
 * Open roles.
 *
 * PUBLISHED ONLY, decided server-side: `listPublic` filters to PUBLISHED
 * because a DRAFT has never been public and a CLOSED role is not open. The
 * client does not re-filter — doing so would be a second source of truth.
 */
export function usePublicJobs(cursor?: string) {
  return useQuery({
    queryKey: ['public-jobs', cursor ?? null],
    queryFn: ({ signal }) =>
      api.get<PublicJobListResponse>('/public/jobs', {
        query: { cursor, limit: PUBLIC_PAGE_SIZE },
        signal,
      }),
  });
}

export function usePublicJob(jobId: string | undefined) {
  return useQuery({
    queryKey: ['public-job', jobId ?? null],
    queryFn: ({ signal }) => api.get<PublicJob>(`/public/jobs/${jobId!}`, { signal }),
    enabled: Boolean(jobId),
  });
}

/* -------------------------------------------------------------------------- */
/* Application submission                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `validateResumeFile` on the server so a bad file is caught before a
 * 10 MB upload is spent proving it.
 *
 * THE SERVER STILL RE-CHECKS, and checks more: it verifies the magic bytes as
 * well as the declared type, so a renamed `.exe` is rejected there even though
 * the browser reported an acceptable MIME. These constants are a courtesy to
 * the candidate, never the security boundary.
 */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_RESUME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
/** What the file picker offers. Extensions included for browsers that ignore MIME. */
export const RESUME_ACCEPT_ATTR =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function describeResumeProblem(file: File): string | null {
  if (file.size === 0) return 'That file is empty. Choose a PDF or DOCX resume.';
  if (file.size > MAX_RESUME_BYTES) {
    return `That file is ${formatBytes(file.size)}. Your resume must be 10 MB or smaller.`;
  }
  /*
   * Some browsers report an empty type for a DOCX. Falling back to the
   * extension keeps a legitimate file from being refused locally — the server
   * inspects the actual bytes either way.
   */
  const named = file.name.toLowerCase();
  const typeOk = (ACCEPTED_RESUME_TYPES as readonly string[]).includes(file.type);
  const extensionOk = named.endsWith('.pdf') || named.endsWith('.docx');
  if (!typeOk && !extensionOk) return 'Resumes must be a PDF or DOCX file.';
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The four values `ApplicationSource` permits. Anything else is a 400. */
export const APPLICATION_SOURCES = ['career_site', 'job_board', 'referral', 'other'] as const;
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];

export const SOURCE_LABELS: Record<ApplicationSource, string> = {
  career_site: 'This careers site',
  job_board: 'A job board',
  referral: 'A referral',
  other: 'Somewhere else',
};

export interface ApplicationDraft {
  fullName: string;
  email: string;
  phone: string;
  source: ApplicationSource | '';
  resume: File | null;
}

/** Phase 1 CA-04 — the confirmation payload. */
export interface SubmissionResult {
  id: string;
  reference: string;
  jobId: string;
  jobTitle: string;
  currentStage: string;
  appliedAt: string;
}

/**
 * FR2.1 — submit the application.
 *
 * FR2.5 GOVERNS THE OUTCOME: submission succeeds and returns a confirmation
 * regardless of parsing, and parsing failure never blocks intake. The server
 * queues the resume after the transaction commits, so a 201 here means the
 * application is recorded even if nothing ever reads the file.
 *
 * `Idempotency-Key` is generated once per attempt by the caller and reused
 * across retries, so a dropped connection cannot produce two applications.
 */
export function useSubmitApplication() {
  return useMutation({
    mutationFn: ({
      draft,
      jobId,
      idempotencyKey,
    }: {
      draft: ApplicationDraft;
      jobId: string;
      idempotencyKey: string;
    }) => {
      const form = new FormData();
      form.append('jobId', jobId);
      form.append('fullName', draft.fullName.trim());
      form.append('email', draft.email.trim());
      // Omitted rather than sent empty: the DTO marks both optional, and an
      // empty string is a value, not an absence.
      if (draft.phone.trim()) form.append('phone', draft.phone.trim());
      if (draft.source) form.append('source', draft.source);
      if (draft.resume) form.append('resume', draft.resume);

      return apiUpload<SubmissionResult>('/applications', form, { idempotencyKey });
    },
  });
}

export function toSkillList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
