import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditActorType, ParseStatus, Prisma } from '@prisma/client';
import { Worker, type Job as QueueJob } from 'bullmq';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  RESUME_QUEUE,
  RESUME_UPLOADED,
  type ResumeUploadedEvent,
} from '../../common/queue/resume-queue.service';
import { StorageService } from '../../common/storage/storage.service';
import { AI_AUDIT_ACTIONS } from './ai-audit-actions';
import { AiServiceClient, type ParseResult } from './ai-service.client';
import { ResumeParserPort, type ResumeParseResult } from './parsing/resume-parser.port';
import { MatchScorerPort } from './scoring/match-scorer.port';
import { assertAllowedFeatures } from './feature-allow-list';
import { DEFAULT_RANKING_WEIGHTS, type RankingWeights } from './dto/ranking-weights.dto';

/** Emitted after a profile is persisted (PRD §20 stage 7). */
export const RESUME_PARSED = 'resume.parsed';

/**
 * The async worker of PRD §15.2 / §23.1.
 *
 *   Q ->> W : deliver resume.uploaded
 *   W ->> AI: POST /internal/ai/parse
 *   AI->> DB: save parsed_profile
 *   ...       embed + score + explain
 *   AI->> DB: save match_score (+rationale, version)
 *
 * Runs in-process. Separating it into its own deployable is a Phase 6
 * concern (PRD §27); nothing about the contract changes when it moves.
 *
 * WHAT IT IS NOT: the model behind AiServiceClient is a deterministic
 * reference implementation. No model has been trained — PRD §19.2's corpus,
 * hiring labels, golden NER dataset and fairness dataset do not exist — so
 * nothing this worker writes is evidence of parsing or ranking quality, and
 * nothing it produces is promotable under §19.6.
 */
@Injectable()
export class ResumeParseWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResumeParseWorker.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ai: AiServiceClient,
    /** FR3 — the local extractor. Bound in `ai.module.ts`; swappable there. */
    private readonly parser: ResumeParserPort,
    /** FR4.1 — the local scorer. Bound alongside the parser. */
    private readonly scorer: MatchScorerPort,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    /*
     * Opt-in. The worker holds a Redis connection open and calls an external
     * service, neither of which belongs in a unit test run or in a process
     * that only serves HTTP.
     */
    if (this.config.get<string>('RESUME_WORKER_ENABLED') !== 'true') {
      this.logger.log('resume worker disabled (set RESUME_WORKER_ENABLED=true to run it)');
      return;
    }

    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.worker = new Worker(
      RESUME_QUEUE,
      async (job: QueueJob<ResumeUploadedEvent>) => {
        if (job.name !== RESUME_UPLOADED) return;
        await this.handle(job.data);
      },
      { connection: { url }, concurrency: 2 },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`resume.uploaded failed for ${job?.data?.resumeId}: ${error.message}`);
    });

    this.logger.log(`resume worker listening on ${RESUME_QUEUE}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  /**
   * One resume, end to end.
   *
   * FR2.5 governs the failure path: the application stays valid whatever
   * happens here. A failure marks `parse_status = FAILED` and stops; it never
   * unwinds the submission.
   */
  async handle(event: ResumeUploadedEvent): Promise<void> {
    const resume = await this.prisma.resume.findUnique({
      where: { id: event.resumeId },
      include: { application: { include: { job: true } } },
    });

    if (!resume) {
      this.logger.warn(`resume ${event.resumeId} no longer exists; nothing to parse`);
      return;
    }

    await this.prisma.resume.update({
      where: { id: resume.id },
      data: { parseStatus: ParseStatus.PROCESSING },
    });

    try {
      /*
       * §20 stage 2 — text extraction.
       *
       * DEVIATION FROM §20, RECORDED DELIBERATELY: the PRD puts extraction in
       * the Python AI service so "the core API never imports model code". That
       * service ships no parser (its requirements.txt omits pdfplumber and
       * python-docx on purpose), so extraction runs here instead, behind
       * `ResumeParserPort`. Nothing imported is model code — it is two document
       * readers and a set of regexes — and the port is the seam that lets the
       * Python implementation take over later without touching this worker.
       *
       * BYTES, NOT TEXT. `readText` decodes as UTF-8, which destroys a PDF and
       * a DOCX alike; that was why nothing was ever really parsed here.
       */
      const bytes = await this.storage.readBytes(resume.s3Key);
      const parsed = await this.parser.parse(bytes, resume.mimeType);

      await this.persistProfile(resume.id, parsed);

      await this.prisma.resume.update({
        where: { id: resume.id },
        data: { parseStatus: ParseStatus.COMPLETED },
      });

      this.logger.log(`${RESUME_PARSED} resume=${resume.id} [${event.correlationId}]`);

      /*
       * Scoring keeps the AI service's own `ParseResult` shape. Adapted here
       * rather than widening that contract, which the Python client shares.
       * `overallConfidence` is non-null there, so an unscored document (no
       * fields produced) presents as 0 — an honest floor, not a guess.
       *
       * NOT IMPLEMENTED IN THIS PHASE: every seeded job has
       * `aiScoringEnabled: false`, so `score()` returns immediately and no
       * match_scores row is written. The call is left in place untouched.
       */
      await this.score(
        resume.application.id,
        resume.application.job,
        { ...parsed, overallConfidence: parsed.overallConfidence ?? 0 } as unknown as ParseResult,
        event.correlationId,
      );
    } catch (error) {
      /*
       * FR2.5 / §20 design note: "if parsing subsequently fails, the
       * application remains valid and is surfaced to the recruiter with a
       * manual-entry prompt". FAILED is that surface.
       */
      await this.prisma.resume.update({
        where: { id: resume.id },
        data: { parseStatus: ParseStatus.FAILED },
      });
      this.logger.error(
        `parse failed for resume ${resume.id}; application remains valid (FR2.5)`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /** §20 stage 7 — persist `parsed_profiles`, one per resume. */
  private async persistProfile(resumeId: string, parsed: ResumeParseResult): Promise<void> {
    const data = {
      // FR3.1 — contact block; absent fields are null inside it, never omitted
      // in a way that would read as "not attempted".
      contact: parsed.contact as unknown as Prisma.InputJsonValue,
      skills: parsed.skills as unknown as Prisma.InputJsonValue,
      workHistory: parsed.workHistory as Prisma.InputJsonValue,
      education: parsed.education as Prisma.InputJsonValue,
      certifications: parsed.certifications as Prisma.InputJsonValue,
      fieldConfidence: parsed.fieldConfidence as Prisma.InputJsonValue,
      confidenceScore: parsed.overallConfidence,
      // FR3.2 — provenance, so a rule-based extraction is never mistaken for a
      // model's output when this row is read back.
      parserName: parsed.parserName,
      parserVersion: parsed.parserVersion,
    };

    await this.prisma.parsedProfile.upsert({
      where: { resumeId },
      create: { resumeId, ...data },
      update: data,
    });
  }

  /**
   * §21.2 step 8 / FR4.4 — write the score ATOMICALLY.
   *
   * "match_scores writes are atomic: score + rationale + feature vector +
   * model version in one transaction." And BR-02: "if rationale generation
   * fails, the transaction aborts — no partial row." Both are enforced
   * below: the rationale is checked before the transaction opens, and every
   * write happens inside it.
   */
  private async score(
    applicationId: string,
    job: {
      id: string;
      companyId: string;
      aiScoringEnabled: boolean;
      rankingWeights: unknown;
      // FR4.1 — the scorer compares against the job's own requirement.
      requiredSkills: unknown;
      experienceLevel: string | null;
    },
    parsed: ParseResult,
    correlationId: string,
  ): Promise<void> {
    // FR4.5 — a job with scoring disabled is not scored at all.
    if (!job.aiScoringEnabled) {
      this.logger.debug(`scoring skipped for job ${job.id}: ai_scoring_enabled=false (FR4.5)`);
      return;
    }

    /*
     * FR4.2 — the job's own weighting, falling back to the documented default
     * when none has been saved. There is deliberately no second weighting
     * system: this is the same `ranking_weights` column RC-08 edits.
     */
    const weights = (job.rankingWeights as RankingWeights | null) ?? DEFAULT_RANKING_WEIGHTS;

    /*
     * FR4.1 — scored locally by `baseline-rules-v1` through `MatchScorerPort`,
     * not by the Python service. Same reasoning as the parser (amendment I):
     * that service ships no model, and routing through it would mean a network
     * hop to a stub. The port keeps the swap to one line in `ai.module.ts`.
     */
    const result = this.scorer.score({
      job: {
        id: job.id,
        requiredSkills: job.requiredSkills,
        experienceLevel: job.experienceLevel,
      },
      profile: {
        skills: parsed.skills,
        workHistory: parsed.workHistory,
        education: parsed.education,
        certifications: parsed.certifications,
      },
      weights,
    });

    // BR-02, before anything is written.
    if (!result.rationale?.summary || !Array.isArray(result.rationale.factors)) {
      throw new Error(`BR-02: no rationale for application ${applicationId}; score discarded`);
    }
    // BR-07, at the last point before persistence.
    assertAllowedFeatures(result.featureVector);

    const version = await this.prisma.aiModelVersion.upsert({
      where: {
        modelName_versionTag: { modelName: result.modelName, versionTag: result.versionTag },
      },
      create: { modelName: result.modelName, versionTag: result.versionTag, status: 'reference' },
      update: {},
    });

    const score = await this.prisma.$transaction(async (tx) =>
      tx.matchScore.create({
        data: {
          applicationId,
          modelVersionId: version.id,
          compositeScore: new Prisma.Decimal(result.composite),
          rationale: result.rationale as unknown as Prisma.InputJsonValue,
          featureVector: result.featureVector as Prisma.InputJsonValue,
        },
      }),
    );

    /*
     * FR4.4 — the score is now on the record. Handoff §I named this action in
     * Phase 2 and left it uncalled; this is its first caller.
     */
    await this.audit.record({
      companyId: job.companyId,
      actorId: null,
      actorType: AuditActorType.PUBLIC,
      action: AI_AUDIT_ACTIONS.SCORE_GENERATED,
      resourceType: 'match_score',
      resourceId: score.id,
      correlationId,
      afterState: {
        applicationId,
        composite: result.composite,
        modelVersion: `${result.modelName}@${result.versionTag}`,
      },
    });
  }
}
