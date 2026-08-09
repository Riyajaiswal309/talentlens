import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { memoryStorage } from 'multer';
import { AiScoringPort } from '../ai/ai-scoring.port';
import { toWireScore, type WireScore } from '../ai/score-view';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CandidateOwned } from '../../common/decorators/resource-access.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import type { ApplicationDetail } from './applications.service';
import { MAX_RESUME_BYTES } from './resume-file';
import { UploadExceptionFilter } from './upload-exception.filter';
import { Public } from '../../common/decorators/public.decorator';
import type { RequestContext } from '../../common/types/authenticated-request';
import { ApplicationsService, toApplicationAuditSnapshot } from './applications.service';
import { SubmitApplicationDto } from './dto/submit-application.dto';

/** Phase 1 CA-04 — confirmation payload. */
interface SubmissionResponse {
  id: string;
  reference: string;
  jobId: string;
  jobTitle: string;
  currentStage: string;
  appliedAt: string;
}

/**
 * Phase 1 CA-05 — application status.
 *
 * The candidate's own contact details are echoed back because the screen
 * shows what was submitted; a Recruiter or Admin reading the same route needs
 * them too. The RESUME is described but never linked: `s3_key` is an internal
 * storage location, and handing it out would let a caller address the bucket
 * directly. Serving the file is a separate concern nothing has specified yet.
 */
interface ApplicationDetailResponse {
  id: string;
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
  resume: {
    /** Always PENDING in Phase 2 — no parser exists (FR2.5). */
    parseStatus: string;
    mimeType: string;
    uploadedAt: string;
  } | null;
  /**
   * RC-06 renders a score panel. Resolved through AiScoringPort.
   *
   * ALWAYS null for a CANDIDATE caller. PRD §24.2 Table 24.1: "View AI
   * rankings + rationale — Recruiter ✓, Hiring Manager ✓ (assigned),
   * Candidate —, Admin ✓". The candidate is the subject of the assessment,
   * not an audience for it; §24.5 makes a candidate-facing explanation a
   * separate request process, not this field.
   */
  score: WireScore | null;
}

function toDetailResponse(
  application: ApplicationDetail,
  score: WireScore | null,
): ApplicationDetailResponse {
  return {
    id: application.id,
    reference: application.id.slice(0, 8).toUpperCase(),
    currentStage: application.currentStage,
    appliedAt: application.appliedAt.toISOString(),
    job: {
      id: application.job.id,
      title: application.job.title,
      department: application.job.department,
      location: application.job.location,
      employmentType: application.job.employmentType,
      status: application.job.status,
    },
    candidate: {
      fullName: application.candidate.fullName,
      email: application.candidate.email,
      phone: application.candidate.phone,
    },
    resume: application.resume
      ? {
          parseStatus: application.resume.parseStatus,
          mimeType: application.resume.mimeType,
          uploadedAt: application.resume.createdAt.toISOString(),
        }
      : null,
    score,
  };
}

/** PRD §23.1. Express lower-cases incoming header names. */
const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Keys are namespaced per endpoint, because §23.1 grants the header to this
 * one endpoint only. A key that means something here cannot collide with a
 * key used anywhere else later.
 */
const IDEMPOTENCY_SCOPE = 'applications';

/** UNSPECIFIED in the PRD — a sanity bound, not a documented rule. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly idempotency: IdempotencyService,
    private readonly ai: AiScoringPort,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * POST /v1/applications — Public (Handoff §B row 12), FR2.1.
   *
   * multipart/form-data: the text fields plus a `resume` file part. PRD §23.1
   * shows the API storing the file itself (`API->>S3`) within this single
   * request, rather than issuing a presigned URL for a browser-to-S3 upload —
   * which is also what lets the antivirus scan run before persistence.
   *
   * @Public() is what makes this reachable without a token; @Audit() is what
   * makes it recorded anyway. Since the approved audit-actor resolution, the
   * record is written with actorType PUBLIC and a null actor rather than
   * skipped, so an unauthenticated submission still leaves evidence.
   */
  @Public()
  @Post()
  @Audit({ action: 'application.submitted', resourceType: 'application' })
  @HttpCode(HttpStatus.CREATED)
  @UseFilters(UploadExceptionFilter)
  @UseInterceptors(
    FileInterceptor('resume', {
      /*
       * Buffered in memory, not on disk. The file is scanned and forwarded to
       * S3 within the request, so a temp file would only widen the window in
       * which an unscanned upload exists on the API host. The 10 MB cap
       * (decision C) is what keeps this bounded.
       */
      storage: memoryStorage(),
      limits: { fileSize: MAX_RESUME_BYTES, files: 1 },
    }),
  )
  async submit(
    @Body() dto: SubmitApplicationDto,
    @UploadedFile() resume: Express.Multer.File | undefined,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Req() req: RequestContext,
  ): Promise<SubmissionResponse> {
    /*
     * The correlation id is carried into the queue so that a Phase 3 worker's
     * logs join up with the HTTP request that created the job (NFR11, PRD
     * §25). CorrelationIdMiddleware guarantees it is present.
     */
    if (!req.correlationId) {
      // Not a fallback: an empty id would publish an untraceable queue job and
      // break the end-to-end trace NFR11 requires.
      throw new Error('CorrelationIdMiddleware did not run before ApplicationsController');
    }

    /*
     * PRD §23.1 — "Idempotency-Key header SUPPORTED on POST /applications".
     * Supported, not required: a request without one behaves exactly as it
     * did before this existed.
     */
    const key = idempotencyKey?.trim();
    if (key !== undefined && key !== '') {
      const replayed = await this.checkIdempotency(key, dto, resume, req);
      if (replayed) return replayed;
    }

    const result = await this.applications
      .submit(dto, resume, req.correlationId)
      .catch(async (error: unknown) => {
        /*
         * A failed attempt created nothing, so it must not burn the key.
         * Otherwise a candidate whose file was rejected could never retry
         * with the same key after fixing it.
         */
        if (key) await this.idempotency.release(IDEMPOTENCY_SCOPE, key);
        throw error;
      });

    /*
     * There is no :id in the route, so the interceptor would otherwise have
     * nothing to audit against. Setting params.id points the audit record at
     * the application that was just created.
     */
    req.params = { ...req.params, id: result.application.id };
    req.auditState = { before: null, after: toApplicationAuditSnapshot(result) };
    /*
     * Public route: no principal, so the tenant comes from the job being
     * applied to. Without this the audit record would have no tenant and
     * AuditService would refuse it (M2.10).
     */
    req.auditCompanyId = result.job.companyId;

    const response: SubmissionResponse = {
      id: result.application.id,
      // Phase 1 CA-04 shows a short reference the applicant can quote.
      reference: result.application.id.slice(0, 8).toUpperCase(),
      jobId: result.job.id,
      jobTitle: result.job.title,
      currentStage: result.application.currentStage,
      appliedAt: result.application.appliedAt.toISOString(),
    };

    /*
     * FR2.3 / CA-04 — confirmation. Awaited but non-throwing: FR2.5 makes
     * intake independent of everything downstream, so a notification failure
     * cannot cost the candidate their application.
     */
    await this.notifications
      .applicationReceived({
        email: result.candidate.email,
        candidateName: result.candidate.fullName,
        jobTitle: result.job.title,
        reference: response.reference,
      })
      // Belt and braces. NotificationsService already swallows transport
      // errors, but FR2.5 makes intake independent of EVERYTHING downstream —
      // a bug in the notifier must not cost a candidate their application.
      .catch(() => undefined);

    /*
     * Recorded only now, AFTER the work succeeded and its audit row is about
     * to be written. Storing the response earlier would let a repeat replay a
     * submission that had not finished.
     */
    if (key) {
      await this.idempotency.complete(
        IDEMPOTENCY_SCOPE,
        key,
        this.fingerprintOf(dto, resume),
        response,
      );
    }

    return response;
  }

  /**
   * Resolve an `Idempotency-Key` against what has been seen before.
   *
   * Returns the original response when this exact request has already
   * succeeded; returns undefined when the caller should proceed.
   */
  private async checkIdempotency(
    key: string,
    dto: SubmitApplicationDto,
    resume: Express.Multer.File | undefined,
    req: RequestContext,
  ): Promise<SubmissionResponse | undefined> {
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException(
        `Idempotency-Key must be ${MAX_IDEMPOTENCY_KEY_LENGTH} characters or fewer`,
      );
    }

    const outcome = await this.idempotency.begin<SubmissionResponse>(
      IDEMPOTENCY_SCOPE,
      key,
      this.fingerprintOf(dto, resume),
    );

    switch (outcome.kind) {
      case 'proceed':
        return undefined;

      case 'replay':
        /*
         * Nothing was created, so nothing is audited. Without this the trail
         * would show two `application.submitted` records for one application
         * and overstate what happened (PRD §17.3).
         */
        req.auditSuppressed = true;
        return outcome.response;

      case 'in_progress':
        // The first request is still running. Its response does not exist
        // yet, so there is nothing truthful to return.
        throw new ConflictException(
          'A submission with this Idempotency-Key is already being processed',
        );

      case 'mismatch':
        /*
         * UNSPECIFIED by the PRD — see the note in IdempotencyService.
         * Refusing is the safe reading: silently replaying the first
         * response would acknowledge a DIFFERENT application that was never
         * created, losing a real submission behind a success.
         */
        throw new ConflictException(
          'This Idempotency-Key was already used for a different submission',
        );
    }
  }

  /** The resume bytes are part of the request, so they are part of its identity. */
  private fingerprintOf(
    dto: SubmitApplicationDto,
    resume: Express.Multer.File | undefined,
  ): string {
    return this.idempotency.fingerprint([
      dto.jobId,
      dto.fullName,
      dto.email,
      dto.phone,
      resume?.originalname,
      resume?.buffer,
    ]);
  }

  /**
   * GET /v1/applications/:id — Candidate (owner), Recruiter, Admin
   * (Handoff §B row 13, Phase 1 CA-05).
   *
   * Hiring Manager is deliberately absent from @Roles: row 13 does not list
   * it. An HM reaches candidate data through GET /v1/jobs/:id/candidates,
   * where JobAssignmentGuard can prove they are assigned to the job. Allowing
   * this route would give them any application in the tenant, assigned or
   * not.
   *
   * @CandidateOwned hands the route to CandidateOwnershipGuard, which
   * constrains CANDIDATE callers to their own application and refuses with
   * 404 rather than 403 (BR-06). Tenant scoping for Recruiter and Admin
   * happens in the service, because `applications` carries no company_id of
   * its own and the tenancy is only reachable through the job.
   *
   * Not audited: PRD §17.3 records actions that change state, and reading
   * one's own application status is not one.
   */
  @Get(':id')
  @Roles(UserRole.CANDIDATE, UserRole.RECRUITER, UserRole.ADMIN)
  @CandidateOwned({ resource: 'application' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationDetailResponse> {
    const application = await this.applications.findOne(user, id);

    /*
     * §24.2 grants no ranking visibility to a Candidate, so the score is not
     * even fetched for one — withheld at the source rather than filtered out
     * of a payload that briefly held it.
     */
    const score =
      user.role === UserRole.CANDIDATE ? null : toWireScore(await this.ai.getScore(application.id));

    return toDetailResponse(application, score);
  }
}
