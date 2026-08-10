import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type Application,
  type ApplicationSource,
  type Candidate,
  type Job,
  JobStatus,
  ParseStatus,
  type Prisma,
  type Resume,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ResumeQueueService } from '../../common/queue/resume-queue.service';
import { ResumeScanner } from '../../common/storage/resume-scanner';
import { StorageService } from '../../common/storage/storage.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import type { ListJobCandidatesQueryDto } from './dto/list-job-candidates.query.dto';
import type { SubmitApplicationDto } from './dto/submit-application.dto';
import { validateResumeFile } from './resume-file';

const DEFAULT_PAGE_SIZE = 25;

/** One application with everything CA-05 renders. */
export type ApplicationDetail = Application & {
  job: Job;
  candidate: Candidate;
  resume: Resume | null;
};

/** One row of the RC-05 candidate list. */
export type JobCandidate = Application & {
  candidate: Candidate;
  resume: { parseStatus: ParseStatus } | null;
};

/**
 * One message for every reason a job cannot be applied to.
 *
 * Phase 1 CA-01 specifies this copy for a closed role. It is reused for a
 * missing or unpublished job so that a public caller cannot distinguish
 * "never existed", "still a draft" and "closed" — otherwise the endpoint
 * would confirm the existence of unpublished requisitions.
 */
const JOB_UNAVAILABLE = 'This role is no longer accepting applications';

export interface SubmissionResult {
  application: Application;
  candidate: Candidate;
  job: Job;
  resume: Resume;
}

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly scanner: ResumeScanner,
    private readonly queue: ResumeQueueService,
  ) {}

  /**
   * FR2.1 — create the candidate, application and resume for a public
   * submission.
   *
   * The step order is fixed by PRD §20 stage 1 and Phase 1 Flow 3 step 3:
   *
   *   validate type & size → ANTIVIRUS SCAN → persist to S3 → create rows
   *     → publish resume.uploaded
   *
   * The scan sits before persistence deliberately. Storing first and scanning
   * afterwards would place unscanned attacker-controlled files in the bucket
   * that the Phase 3 parser later reads, so the order is a security property
   * rather than a preference.
   *
   * Parsing is NOT performed here and is not waited on. FR2.5 requires 201 to
   * be returned without it, so `parse_status` stays PENDING and the work is
   * handed to the queue.
   *
   * Tenancy is derived from the job, never from the request: a public caller
   * has no principal and therefore no tenant to trust.
   */
  async submit(
    dto: SubmitApplicationDto,
    file: Express.Multer.File | undefined,
    correlationId: string,
  ): Promise<SubmissionResult> {
    const job = await this.prisma.job.findUnique({
      where: { id: dto.jobId },
      include: { stages: { orderBy: { position: 'asc' }, take: 1 } },
    });

    // Only a PUBLISHED job accepts applications. A DRAFT has never been
    // public and a CLOSED one has stopped being so.
    if (!job || job.status !== JobStatus.PUBLISHED) {
      throw new NotFoundException(JOB_UNAVAILABLE);
    }

    /*
     * The opening stage comes from the job's own pipeline, not a hard-coded
     * 'Applied'. Decision B2 makes stages per-job configurable, so a job whose
     * first stage was renamed must still place applicants correctly.
     */
    const firstStage = job.stages[0];
    if (!firstStage) {
      // JobsService creates the six defaults in the same transaction as the
      // job, so this indicates data corruption rather than a user error.
      throw new Error(`Job ${job.id} has no pipeline stages; cannot place an applicant`);
    }

    // ---- 1. Validate type and size (§20 stage 1, first half) --------------
    const resumeFile = validateResumeFile(file);

    // ---- 2. Antivirus scan, BEFORE anything is persisted -----------------
    const scan = await this.scanner.scan(resumeFile.buffer, resumeFile.filename);
    if (!scan.clean) {
      // Phase 1 CA-02 requires a distinct recovery message for AV failure.
      // The signature name is logged by the scanner but not returned: it tells
      // an uploader exactly which payload was detected.
      throw new BadRequestException(
        'That file failed our security scan and was not stored. Upload a different copy of your resume',
      );
    }

    // ---- 3. Persist the file --------------------------------------------
    const s3Key = this.storage.buildResumeKey(job.companyId, resumeFile.extension);
    await this.storage.put(s3Key, resumeFile.buffer, resumeFile.mimeType);

    // ---- 4. Create the rows ---------------------------------------------
    let result: SubmissionResult;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        /*
         * APPROVED: conservative candidate deduplication policy (8 Aug 2026).
         *
         * Every public submission creates its OWN candidate row. An existing
         * candidate is never reused on an email match, and no unique
         * constraint or company_id was added to support matching.
         *
         * The two reasons this is the safe default, for whoever revisits it:
         *   1. `candidates` is not tenant-scoped (PRD §17.2 — no company_id),
         *      so matching on email alone would join one person's records
         *      across unrelated companies.
         *   2. This endpoint is public and unauthenticated. Attaching a
         *      submission to an existing profile would let anyone append an
         *      application to a real person's record by typing their address.
         *
         * Consequence to accept knowingly: one person applying to three roles
         * produces three candidate rows.
         */
        const candidate = await tx.candidate.create({
          data: {
            fullName: dto.fullName.trim(),
            email: dto.email.toLowerCase().trim(),
            phone: dto.phone?.trim() ?? null,
            // userId stays null: a public applicant has no login account
            // (rule 1 of the approved candidate-identity resolution).
          },
        });

        const application = await tx.application.create({
          data: {
            jobId: job.id,
            candidateId: candidate.id,
            currentStage: firstStage.name,
            // FR7.3. Undefined when the candidate did not answer, which
            // stores NULL — "not recorded", distinct from `other`.
            source: dto.source,
          },
        });

        const resume = await tx.resume.create({
          data: {
            applicationId: application.id,
            s3Key,
            mimeType: resumeFile.mimeType,
            // FR2.5 — submission never waits on parsing. A Phase 3 worker
            // moves this off PENDING; nothing in Phase 2 does.
            parseStatus: ParseStatus.PENDING,
          },
        });

        return { application, candidate, job, resume };
      });
    } catch (error) {
      /*
       * The file is already in the bucket but no row will ever reference it.
       * Remove it rather than leaving an orphan that no retention policy
       * covers, then let the original failure propagate unchanged.
       */
      await this.storage.deleteQuietly(s3Key);
      throw error;
    }

    /*
     * ---- 5. Publish resume.uploaded (PRD §23.1, Phase 1 Flow 3 step 4) ----
     *
     * Deliberately OUTSIDE the transaction and after it has committed. A
     * consumer resolves the job by resume id, so publishing from inside the
     * transaction would let a worker read `resumes` before the row was
     * visible and conclude the resume does not exist.
     *
     * Nothing consumes this queue in Phase 2 — the parser is Phase 3
     * (Handoff §G). The event is published now so that the ordering, the
     * payload and the correlation id are settled before a consumer depends
     * on them.
     */
    try {
      await this.queue.publishResumeUploaded({
        resumeId: result.resume.id,
        correlationId,
      });
    } catch (error) {
      /*
       * A queue outage must NOT fail the submission. FR2.5 makes intake
       * independent of parsing, and PRD §20 states the application "remains
       * valid" when parsing does not happen — losing a candidate's completed
       * application because Redis was briefly unavailable would be a far
       * worse outcome than a delayed parse.
       *
       * The resume stays at parse_status PENDING, which is exactly the
       * backlog the PRD §17.4 partial index exists to make cheap to find, so
       * an unpublished resume is recoverable rather than lost.
       */
      this.logger.error(
        `resume.uploaded NOT published for resume=${result.resume.id} — it stays PENDING [${correlationId}]`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return result;
  }

  /**
   * GET /v1/applications/:id — Candidate (owner), Recruiter, Admin
   * (Handoff §B row 13, Phase 1 CA-05).
   *
   * Two different access rules, deliberately kept apart:
   *
   *   - A CANDIDATE has already been proved the owner by
   *     CandidateOwnershipGuard, so no company filter is applied. A candidate
   *     applies across tenants; scoping their own application to their user's
   *     companyId would hide their own record from them.
   *
   *   - A RECRUITER or ADMIN is scoped to their tenant here. `applications`
   *     has no company_id of its own (PRD §17.2), so tenancy is reached
   *     through the job — which is also why this cannot be left to a guard
   *     that only sees the route parameter.
   *
   * Every refusal is 404, never 403 (BR-06, PRD §26): a 403 would confirm
   * that an application id exists in some other tenant.
   */
  async findOne(user: AuthenticatedUser, id: string): Promise<ApplicationDetail> {
    const scopedToTenant = user.role !== UserRole.CANDIDATE;

    const application = await this.prisma.application.findFirst({
      where: {
        id,
        ...(scopedToTenant ? { job: { companyId: user.companyId } } : {}),
      },
      include: {
        job: true,
        candidate: true,
        resume: true,
      },
    });

    if (!application) throw new NotFoundException();
    return application;
  }

  /**
   * PATCH /v1/applications/:id/source — FR7.3 correction (amendment B7).
   *
   * Recruiter and Administrator only; the controller's @Roles enforces that,
   * and the tenant scope here is unconditional because neither role may reach
   * outside their own company. A candidate never reaches this method at all —
   * unlike `findOne`, there is no self-access branch, because attribution is
   * the hiring team's record of how someone arrived rather than the
   * candidate's own data (D33).
   *
   * Refusal is 404, never 403 (BR-06, PRD §26).
   *
   * Returns the previous value alongside the new one so the controller can
   * hand both to the audit interceptor: a correction changes a reported
   * business metric, and "was job_board, now referral" is the whole point of
   * the record.
   */
  async updateSource(
    user: AuthenticatedUser,
    id: string,
    source: ApplicationSource,
  ): Promise<{ application: Application; previousSource: ApplicationSource | null }> {
    const existing = await this.prisma.application.findFirst({
      where: { id, job: { companyId: user.companyId } },
      select: { id: true, source: true },
    });

    if (!existing) throw new NotFoundException();

    const application = await this.prisma.application.update({
      where: { id: existing.id },
      data: { source },
    });

    return { application, previousSource: existing.source };
  }

  /**
   * GET /v1/jobs/:id/candidates — Recruiter, HM, Admin
   * (Handoff §B row 14, PRD §23.3, Phase 1 RC-05).
   *
   * JobAssignmentGuard has already proved the job is in the caller's tenant
   * and, for a Hiring Manager, that they are assigned to it. The companyId
   * filter is repeated anyway: defence in depth costs nothing, and a future
   * caller that bypasses the guard must not become a cross-tenant read
   * (risk R-09).
   *
   * ORDERING IS REVERSE-CHRONOLOGICAL, NOT RANKED. FR4.5: "Where
   * ai_scoring_enabled is false for a job, candidates are presented in
   * reverse-chronological order with no score displayed." No AI runs in
   * Phase 2, so per the Handoff this is not a stopgap — it is the specified
   * Phase 2 rendering, and the one every consumer must handle correctly.
   */
  async listForJob(
    user: AuthenticatedUser,
    jobId: string,
    query: ListJobCandidatesQueryDto,
  ): Promise<{ data: JobCandidate[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const rows = await this.prisma.application.findMany({
      where: { jobId, job: { companyId: user.companyId } },
      include: { candidate: true, resume: { select: { parseStatus: true } } },
      // `id` breaks ties so the ordering is total and the cursor can neither
      // skip nor repeat a row between pages.
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    return { data, nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null };
  }
}

/**
 * FR2.5 note for both read methods below: `parse_status` is surfaced as-is.
 * Phase 2 has no parser, so it is always PENDING — and an application is
 * complete and readable regardless.
 */

/** Snapshot written to audit_logs after-state (PRD §17.3). */
export function toApplicationAuditSnapshot(result: SubmissionResult): Prisma.InputJsonValue {
  return {
    applicationId: result.application.id,
    jobId: result.job.id,
    jobTitle: result.job.title,
    candidateId: result.candidate.id,
    currentStage: result.application.currentStage,
    appliedAt: result.application.appliedAt.toISOString(),
    resumeId: result.resume.id,
    // The key, not the file: an auditor needs to know which object was
    // attached without the audit trail duplicating candidate data.
    resumeKey: result.resume.s3Key,
  } as Prisma.InputJsonValue;
}
