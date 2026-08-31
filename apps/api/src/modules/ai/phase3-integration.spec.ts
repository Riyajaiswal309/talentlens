import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JobStatus, ParseStatus, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AiModule } from './ai.module';
import { AiScoringPort } from './ai-scoring.port';
import { type ParseResult } from './ai-service.client';
import { ResumeParserPort, type ResumeParseResult } from './parsing/resume-parser.port';
import { MatchScorerPort } from './scoring/match-scorer.port';
import { DEFAULT_RANKING_WEIGHTS } from './dto/ranking-weights.dto';
import { CONFIDENCE_THRESHOLD } from './dto/parse-review.dto';
import { ResumeParseWorker } from './resume-parse.worker';
import { ApplicationsModule } from '../applications/applications.module';
import { ApplicationsService } from '../applications/applications.service';
import { AuditService } from '../../common/audit/audit.service';
import { CommonModule } from '../../common/common.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { CandidateOwnershipGuard } from '../../common/guards/candidate-ownership.guard';
import { JobAssignmentGuard } from '../../common/guards/job-assignment.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';
import { CorrelationIdInterceptor } from '../../common/interceptors/correlation-id.interceptor';
import { CorrelationIdMiddleware } from '../../common/middleware/correlation-id.middleware';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TokenService } from '../auth/token.service';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * Phase 3 integration — FR3.2, FR4.2, FR4.4, BR-02, BR-07, §20, §21.
 *
 * The AI service is stubbed at the HTTP client boundary rather than run as a
 * process: what is under test is the INTEGRATION — the parse lifecycle, the
 * atomic score write, BR-02's abort, BR-07's allow-list, and the endpoints —
 * not the reference implementation's arithmetic, which is not a model and is
 * not evidence of anything.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

const GOOD_PARSE: ParseResult = {
  skills: ['python', 'sql'],
  workHistory: [{ years: 6 }],
  education: [{ degree: 'B.Tech' }],
  certifications: [],
  fieldConfidence: {
    'skills[0]': 0.91,
    // Below 0.75 — FR3.2 flags it rather than accepting it.
    'skills[1]': 0.62,
    'education[0].degree': 0.55,
  },
  overallConfidence: 0.69,
};

const GOOD_SCORE = {
  composite: 0.7321,
  featureVector: {
    semantic_similarity: 0.8,
    skill_overlap: 0.7,
    years_experience_delta: 0.6,
    education_match: 0.5,
    recency_relevant_exp: 0.4,
    certification_match: 0.3,
  },
  rationale: {
    summary: 'Reference stub: strongest signals were semantic similarity, skill overlap.',
    factors: [{ feature: 'skill_overlap', contribution: 0.21, direction: 'positive' as const }],
  },
  modelName: 'reference-stub',
  versionTag: 'not-trained-v0',
};

/** Widens a legacy `ParseResult` fixture to the FR3 `ResumeParseResult` shape. */
function toParserResult(parse: ParseResult): ResumeParseResult {
  return {
    ...parse,
    // The legacy fixture types skills as unknown[]; the port narrows to string[].
    skills: (parse.skills as unknown[]).filter((s): s is string => typeof s === 'string'),
    contact: { name: null, email: null, phone: null, location: null },
    overallConfidence: parse.overallConfidence,
    parserName: 'rule-based-local',
    parserVersion: 'v1',
    limitations: [],
  };
}

describe('Phase 3 integration (FR3.2, FR4.2, FR4.4, BR-02, BR-07)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let jobs: JobsService;
  let applications: ApplicationsService;
  let tokens: TokenService;
  let worker: ResumeParseWorker;
  /*
   * FR3/FR4 moved extraction and scoring behind ports; the worker no longer
   * talks to `AiServiceClient`. These are the collaborators it actually uses,
   * and mocking them here also keeps `pdf-parse` out of the Jest VM, which
   * cannot service pdfjs's dynamic import without --experimental-vm-modules.
   */
  let parser: ResumeParserPort;
  let scorer: MatchScorerPort;
  let storage: StorageService;
  let port: AiScoringPort;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;

  let companyA = '';
  let companyB = '';
  let recruiterA = '';
  let adminA = '';
  let hmA = '';
  let candidateA = '';
  let recruiterB = '';
  let scoredJob = '';
  let unscoredJob = '';
  let closedJob = '';
  let jobB = '';

  const pdf = () =>
    ({
      fieldname: 'resume',
      originalname: 'resume.pdf',
      encoding: '7bit',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
      size: 16,
    }) as Express.Multer.File;

  async function tokenFor(userId: string): Promise<string> {
    const user = await prisma.users.findUniqueOrThrow({ where: { id: userId } });
    return tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    });
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function newApplication(tag: string, job: string): Promise<string> {
    const result = await applications.submit(
      { jobId: job, fullName: `P3 ${tag}`, email: `${tag}.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
    return result.application.id;
  }

  async function resumeOf(applicationId: string): Promise<string> {
    const resume = await owner.resume.findFirstOrThrow({ where: { applicationId } });
    return resume.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        NotificationsModule,
        AuthModule,
        JobsModule,
        ApplicationsModule,
        AiModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: RequestContext, res: Response, next: NextFunction) =>
      new CorrelationIdMiddleware().use(req, res, next),
    );

    const reflector = app.get(Reflector);
    app.useGlobalInterceptors(
      new CorrelationIdInterceptor(),
      new AuditInterceptor(reflector, app.get(AuditService)),
    );
    app.useGlobalGuards(
      app.get(JwtAuthGuard),
      new RolesGuard(reflector),
      new TenantGuard(),
      app.get(JobAssignmentGuard),
      app.get(CandidateOwnershipGuard),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jobs = moduleRef.get(JobsService);
    applications = moduleRef.get(ApplicationsService);
    tokens = moduleRef.get(TokenService);
    worker = moduleRef.get(ResumeParseWorker);
    parser = moduleRef.get(ResumeParserPort);
    scorer = moduleRef.get(MatchScorerPort);
    storage = moduleRef.get(StorageService);
    port = moduleRef.get(AiScoringPort);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `P3A ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `P3B ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
      });
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'p3-rec-a');
    adminA = await makeUser(companyA, UserRole.ADMIN, 'p3-adm-a');
    hmA = await makeUser(companyA, UserRole.HIRING_MANAGER, 'p3-hm-a');
    candidateA = await makeUser(companyA, UserRole.CANDIDATE, 'p3-cand');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'p3-rec-b');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `p3-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: recruiterB,
      email: `p3-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    const scored = await jobs.create(recA, { title: `P3 scored ${suffix}` });
    await jobs.update(recA, scored.id, { status: JobStatus.PUBLISHED });
    await owner.job.update({ where: { id: scored.id }, data: { aiScoringEnabled: true } });
    scoredJob = scored.id;

    const unscored = await jobs.create(recA, { title: `P3 unscored ${suffix}` });
    await jobs.update(recA, unscored.id, { status: JobStatus.PUBLISHED });
    unscoredJob = unscored.id;

    const closed = await jobs.create(recA, { title: `P3 closed ${suffix}` });
    await jobs.update(recA, closed.id, { status: JobStatus.PUBLISHED });
    await jobs.update(recA, closed.id, { status: JobStatus.CLOSED });
    closedJob = closed.id;

    const inB = await jobs.create(recB, { title: `P3 jobB ${suffix}` });
    await jobs.update(recB, inB.id, { status: JobStatus.PUBLISHED });
    jobB = inB.id;

    // The AI service is not run here; its HTTP boundary is stubbed.
    jest.spyOn(storage, 'readText').mockResolvedValue('python sql 6 years B.Tech');
  });

  afterAll(async () => {
    try {
      const companies = [companyA, companyB];
      const applicationIds = (
        await owner.application.findMany({
          where: { job: { companyId: { in: companies } } },
          select: { id: true },
        })
      ).map((r) => r.id);

      await owner.matchScore.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.stageHistory.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
      await owner.candidate.deleteMany({ where: { email: { contains: suffix } } });
      await owner.aiModelVersion.deleteMany({ where: { versionTag: 'not-trained-v0' } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(storage, 'readText').mockResolvedValue('python sql 6 years B.Tech');
  });

  // =========================================================================
  // §20 — the parse lifecycle
  // =========================================================================
  describe('parse lifecycle (§20, FR2.5)', () => {
    it('PENDING → COMPLETED and a parsed_profile is written', async () => {
      const applicationId = await newApplication('life1', unscoredJob);
      const resumeId = await resumeOf(applicationId);

      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));

      await expect(
        owner.resume.findUniqueOrThrow({ where: { id: resumeId } }),
      ).resolves.toMatchObject({ parseStatus: ParseStatus.PENDING });

      await worker.handle({ resumeId, correlationId: CORRELATION });

      const resume = await owner.resume.findUniqueOrThrow({
        where: { id: resumeId },
        include: { parsedProfile: true },
      });
      expect(resume.parseStatus).toBe(ParseStatus.COMPLETED);
      expect(resume.parsedProfile?.skills).toEqual(['python', 'sql']);
      expect(resume.parsedProfile?.confidenceScore).toBeCloseTo(0.69, 2);
    });

    it('records per-field confidence for FR3.2', async () => {
      const applicationId = await newApplication('life2', unscoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));

      await worker.handle({ resumeId, correlationId: CORRELATION });

      const profile = await owner.parsedProfile.findUniqueOrThrow({ where: { resumeId } });
      expect(profile.fieldConfidence).toMatchObject({ 'skills[0]': 0.91, 'skills[1]': 0.62 });
    });

    /** FR2.5 — "the application remains valid" whatever parsing does. */
    it('a parse failure marks FAILED and leaves the application intact', async () => {
      const applicationId = await newApplication('life3', unscoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockRejectedValue(new Error('AI service unavailable'));

      await expect(worker.handle({ resumeId, correlationId: CORRELATION })).rejects.toThrow(
        'AI service unavailable',
      );

      const resume = await owner.resume.findUniqueOrThrow({ where: { id: resumeId } });
      expect(resume.parseStatus).toBe(ParseStatus.FAILED);

      const application = await owner.application.findUniqueOrThrow({
        where: { id: applicationId },
      });
      expect(application.currentStage).toBe('Applied');
    });

    it('re-parsing updates the existing profile rather than duplicating it', async () => {
      const applicationId = await newApplication('life4', unscoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));

      await worker.handle({ resumeId, correlationId: CORRELATION });
      await worker.handle({ resumeId, correlationId: CORRELATION });

      await expect(owner.parsedProfile.count({ where: { resumeId } })).resolves.toBe(1);
    });

    it('a deleted resume is skipped, not an error', async () => {
      await expect(
        worker.handle({ resumeId: randomUUID(), correlationId: CORRELATION }),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // §21.2 / FR4.4 / BR-02 / BR-07 — the score write
  // =========================================================================
  describe('scoring (§21.2, FR4.4, BR-02, BR-07)', () => {
    it('writes score, rationale, feature vector and model version together', async () => {
      const applicationId = await newApplication('score1', scoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      jest.spyOn(scorer, 'score').mockReturnValue(GOOD_SCORE);

      await worker.handle({ resumeId, correlationId: CORRELATION });

      const score = await owner.matchScore.findFirstOrThrow({
        where: { applicationId },
        include: { modelVersion: true },
      });
      expect(Number(score.compositeScore)).toBeCloseTo(0.7321, 4);
      expect(score.rationale).toMatchObject({ summary: expect.any(String) });
      expect(score.featureVector).toMatchObject({ skill_overlap: 0.7 });
      expect(score.modelVersion.versionTag).toBe('not-trained-v0');
    });

    /** BR-02 — "if rationale generation fails, the transaction aborts". */
    it('BR-02: no rationale means NO row at all', async () => {
      const applicationId = await newApplication('score-br02', scoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      jest.spyOn(scorer, 'score').mockReturnValue({
        ...GOOD_SCORE,
        rationale: { summary: '', factors: [] },
      });

      await expect(worker.handle({ resumeId, correlationId: CORRELATION })).rejects.toThrow(
        /BR-02/,
      );

      await expect(owner.matchScore.count({ where: { applicationId } })).resolves.toBe(0);
    });

    /** BR-07 — a protected attribute must never reach the feature vector. */
    it('BR-07: a feature outside Table 19.1 aborts the write', async () => {
      const applicationId = await newApplication('score-br07', scoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      jest.spyOn(scorer, 'score').mockReturnValue({
        ...GOOD_SCORE,
        featureVector: { ...GOOD_SCORE.featureVector, candidate_age: 34 },
      });

      await expect(worker.handle({ resumeId, correlationId: CORRELATION })).rejects.toThrow(
        /BR-07/,
      );
      await expect(owner.matchScore.count({ where: { applicationId } })).resolves.toBe(0);
    });

    /** FR4.5 — a job with scoring disabled is never scored. */
    it('FR4.5: no score is written when ai_scoring_enabled is false', async () => {
      const applicationId = await newApplication('score-off', unscoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      const scoreSpy = jest.spyOn(scorer, 'score');

      await worker.handle({ resumeId, correlationId: CORRELATION });

      expect(scoreSpy).not.toHaveBeenCalled();
      await expect(owner.matchScore.count({ where: { applicationId } })).resolves.toBe(0);
    });

    /** Handoff §I — the hook that never fired in Phase 2 now has a caller. */
    it('FR4.4: writes score.generated', async () => {
      const applicationId = await newApplication('score-audit', scoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      jest.spyOn(scorer, 'score').mockReturnValue(GOOD_SCORE);

      await worker.handle({ resumeId, correlationId: CORRELATION });

      const score = await owner.matchScore.findFirstOrThrow({ where: { applicationId } });
      const row = await owner.auditLog.findFirstOrThrow({
        where: { resourceId: score.id, action: 'score.generated' },
      });
      expect(row.companyId).toBe(companyA);
      expect(row.correlationId).toBe(CORRELATION);
    });

    it('uses the job’s configured weights when present', async () => {
      const applicationId = await newApplication('score-weights', scoredJob);
      const resumeId = await resumeOf(applicationId);
      const custom = { ...DEFAULT_RANKING_WEIGHTS, skill_overlap: 0.5, semantic_similarity: 0.1 };
      await owner.job.update({ where: { id: scoredJob }, data: { rankingWeights: custom } });

      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      const scoreSpy = jest.spyOn(scorer, 'score').mockReturnValue(GOOD_SCORE);

      await worker.handle({ resumeId, correlationId: CORRELATION });

      expect(scoreSpy).toHaveBeenCalledWith(expect.objectContaining({ weights: custom }));
      await owner.job.update({ where: { id: scoredJob }, data: { rankingWeights: Prisma.DbNull } });
    });

    /** BR-01 — no AI path may move a candidate. */
    it('BR-01: scoring never touches the stage', async () => {
      const applicationId = await newApplication('score-br01', scoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      jest.spyOn(scorer, 'score').mockReturnValue(GOOD_SCORE);

      await worker.handle({ resumeId, correlationId: CORRELATION });

      const application = await owner.application.findUniqueOrThrow({
        where: { id: applicationId },
      });
      expect(application.currentStage).toBe('Applied');
      await expect(owner.stageHistory.count({ where: { applicationId } })).resolves.toBe(0);
    });
  });

  // =========================================================================
  // The seam, now persisted
  // =========================================================================
  describe('AiScoringPort → PersistedAiProvider', () => {
    it('getScore returns NotScored when nothing has scored', async () => {
      const applicationId = await newApplication('seam1', unscoredJob);
      await expect(port.getScore(applicationId)).resolves.toEqual({ scored: false });
    });

    it('getScore returns the persisted score with its rationale', async () => {
      const applicationId = await newApplication('seam2', scoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      jest.spyOn(scorer, 'score').mockReturnValue(GOOD_SCORE);
      await worker.handle({ resumeId, correlationId: CORRELATION });

      const result = await port.getScore(applicationId);

      expect(result.scored).toBe(true);
      if (result.scored) {
        expect(result.composite).toBeCloseTo(0.7321, 4);
        expect(result.modelVersion).toBe('reference-stub@not-trained-v0');
        expect(result.rationale.summary).toBeTruthy();
        expect(result.overridden).toBe(false);
      }
    });

    it('the score surfaces on GET /jobs/:id/candidates', async () => {
      const applicationId = await newApplication('seam3', scoredJob);
      const resumeId = await resumeOf(applicationId);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      jest.spyOn(scorer, 'score').mockReturnValue(GOOD_SCORE);
      await worker.handle({ resumeId, correlationId: CORRELATION });

      const response = await request(app.getHttpServer())
        .get(`/jobs/${scoredJob}/candidates?limit=100`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const row = response.body.data.find(
        (r: { applicationId: string }) => r.applicationId === applicationId,
      );
      expect(row.score).not.toBeNull();
      expect(row.score.rationale.summary).toBeTruthy();
      expect(row.score.modelVersion).toBe('reference-stub@not-trained-v0');
    });

    /** BR-02 at the render boundary: a score with no rationale is withheld. */
    it('BR-02: a rationale-less row is reported NotScored rather than rendered', async () => {
      const applicationId = await newApplication('seam4', scoredJob);
      const version = await owner.aiModelVersion.findFirstOrThrow();
      await owner.$executeRawUnsafe(
        `INSERT INTO match_scores (id, application_id, model_version_id, composite_score, rationale, feature_vector, scored_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 0.5, '{}'::jsonb, '{}'::jsonb, now(), now(), now())`,
        applicationId,
        version.id,
      );

      await expect(port.getScore(applicationId)).resolves.toEqual({ scored: false });
    });
  });

  // =========================================================================
  // Gap 2 — ranking weights
  // =========================================================================
  describe('ranking weights (FR4.2, Gap 2)', () => {
    const weights = (token: string, jobId: string) =>
      request(app.getHttpServer()).get(`/jobs/${jobId}/ranking-weights`).set(auth(token));

    const setWeights = (token: string, jobId: string, body: object) =>
      request(app.getHttpServer())
        .put(`/jobs/${jobId}/ranking-weights`)
        .set(auth(token))
        .send(body);

    const valid = { ...DEFAULT_RANKING_WEIGHTS };

    it('returns the defaults with isDefault true', async () => {
      const response = await weights(await tokenFor(recruiterA), unscoredJob).expect(200);

      expect(response.body.isDefault).toBe(true);
      expect(response.body.weights).toEqual(DEFAULT_RANKING_WEIGHTS);
      expect(response.body.updatedAt).toBeNull();
    });

    it('stores weights and reports the affected applications', async () => {
      const response = await setWeights(await tokenFor(recruiterA), scoredJob, {
        weights: valid,
      }).expect(200);

      expect(response.body.weights).toEqual(valid);
      expect(typeof response.body.affectedApplicationCount).toBe('number');
      // scoredJob has ai_scoring_enabled = true.
      expect(response.body.rescoreStatus).toBe('queued');
    });

    it('reads back with isDefault false and a timestamp', async () => {
      const response = await weights(await tokenFor(recruiterA), scoredJob).expect(200);
      expect(response.body.isDefault).toBe(false);
      expect(response.body.updatedAt).toBeTruthy();
    });

    /** Decision D9 — the write is accepted; only the rescore is not applicable. */
    it('D9: rescoreStatus is not_applicable when AI scoring is off', async () => {
      const response = await setWeights(await tokenFor(recruiterA), unscoredJob, {
        weights: valid,
      }).expect(200);

      expect(response.body.rescoreStatus).toBe('not_applicable');
    });

    // ---- BR-07, the enforcement point Gap 2 names ------------------------

    it('BR-07: rejects an unknown key', async () => {
      await setWeights(await tokenFor(recruiterA), scoredJob, {
        weights: { ...valid, candidate_age: 0 },
      }).expect(400);
    });

    it('BR-07: rejects a protected attribute outright', async () => {
      for (const key of ['gender', 'age', 'nationality', 'photograph']) {
        await setWeights(await tokenFor(recruiterA), scoredJob, {
          weights: { ...valid, [key]: 0 },
        }).expect(400);
      }
    });

    it('rejects a missing key — exactly six, no fewer', async () => {
      const { certification_match: _omitted, ...incomplete } = valid;
      await setWeights(await tokenFor(recruiterA), scoredJob, { weights: incomplete }).expect(400);
    });

    it('rejects a value outside [0,1]', async () => {
      await setWeights(await tokenFor(recruiterA), scoredJob, {
        weights: { ...valid, skill_overlap: 1.4 },
      }).expect(400);
    });

    it('rejects weights that do not sum to 1.0', async () => {
      const response = await setWeights(await tokenFor(recruiterA), scoredJob, {
        weights: { ...valid, skill_overlap: 0.9 },
      }).expect(400);

      expect(response.body.detail).toMatch(/sum to 1\.0/i);
    });

    it('accepts a sum within the documented tolerance', async () => {
      await setWeights(await tokenFor(recruiterA), scoredJob, {
        weights: { ...valid, skill_overlap: 0.3005 },
      }).expect(200);
    });

    it('409s on a closed job', async () => {
      const response = await setWeights(await tokenFor(recruiterA), closedJob, {
        weights: valid,
      }).expect(409);
      expect(response.body.detail).toMatch(/closed job/i);
    });

    it('audits the change', async () => {
      await setWeights(await tokenFor(adminA), scoredJob, { weights: valid }).expect(200);

      const row = await owner.auditLog.findFirstOrThrow({
        where: { resourceId: scoredJob, action: 'job.ranking_weights_changed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.actorId).toBe(adminA);
    });

    // ---- authorisation ----------------------------------------------------

    it('refuses a Hiring Manager and a Candidate', async () => {
      await weights(await tokenFor(hmA), scoredJob).expect(403);
      await weights(await tokenFor(candidateA), scoredJob).expect(403);
    });

    it('404s another tenant', async () => {
      await weights(await tokenFor(recruiterA), jobB).expect(404);
      await setWeights(await tokenFor(recruiterA), jobB, { weights: valid }).expect(404);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get(`/jobs/${scoredJob}/ranking-weights`).expect(401);
    });
  });

  // =========================================================================
  // Gap 3 — parse review
  // =========================================================================
  describe('parse review (FR3.2, Gap 3)', () => {
    let reviewApplication = '';
    let reviewProfile = '';

    beforeAll(async () => {
      reviewApplication = await newApplication('review', unscoredJob);
      const resumeId = await resumeOf(reviewApplication);
      jest.spyOn(parser, 'parse').mockResolvedValue(toParserResult(GOOD_PARSE));
      await worker.handle({ resumeId, correlationId: CORRELATION });
      jest.restoreAllMocks();
      jest.spyOn(storage, 'readText').mockResolvedValue('python sql 6 years B.Tech');

      reviewProfile = (await owner.parsedProfile.findFirstOrThrow({ where: { resumeId } })).id;
      // Link the candidate login for the owner-correction case.
      const application = await owner.application.findUniqueOrThrow({
        where: { id: reviewApplication },
      });
      await owner.candidate.update({
        where: { id: application.candidateId },
        data: { userId: candidateA },
      });
    });

    it('lists only fields below the 0.75 threshold', async () => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${unscoredJob}/parse-review?limit=100`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const item = response.body.data.find(
        (r: { applicationId: string }) => r.applicationId === reviewApplication,
      );
      expect(item).toBeDefined();

      const fields = item.flaggedFields as { field: string; confidence: number }[];
      expect(fields.every((f) => f.confidence < CONFIDENCE_THRESHOLD)).toBe(true);
      expect(fields.map((f) => f.field)).toContain('skills[1]');
      // 0.91 is above the threshold and must not appear.
      expect(fields.map((f) => f.field)).not.toContain('skills[0]');
    });

    it('returns the extracted value alongside the confidence', async () => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${unscoredJob}/parse-review?limit=100`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const item = response.body.data.find(
        (r: { applicationId: string }) => r.applicationId === reviewApplication,
      );
      const skill = item.flaggedFields.find((f: { field: string }) => f.field === 'skills[1]');
      expect(skill.extractedValue).toBe('sql');
      expect(item.candidateName).toBe('P3 review');
    });

    it('refuses a Hiring Manager (§24.2 gives no correction rights)', async () => {
      await request(app.getHttpServer())
        .get(`/jobs/${unscoredJob}/parse-review`)
        .set(auth(await tokenFor(hmA)))
        .expect(403);
    });

    it('404s a job in another tenant', async () => {
      await request(app.getHttpServer())
        .get(`/jobs/${jobB}/parse-review`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(404);
    });

    // ---- PATCH /parsed-profiles/:id ---------------------------------------

    it('confirming a field sets confidence to 1.0 and records the actor', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/parsed-profiles/${reviewProfile}`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ fields: { 'skills[1]': { value: 'SQL', confirmed: true } } })
        .expect(200);

      expect(response.body.confirmedFields).toEqual(['skills[1]']);

      const profile = await owner.parsedProfile.findUniqueOrThrow({ where: { id: reviewProfile } });
      expect((profile.fieldConfidence as Record<string, number>)['skills[1]']).toBe(1);
      const confirmations = profile.fieldConfirmations as Record<string, { by: string }>;
      expect(confirmations['skills[1]']?.by).toBe(recruiterA);
    });

    it('a confirmed field leaves the review queue', async () => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${unscoredJob}/parse-review?limit=100`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const item = response.body.data.find(
        (r: { applicationId: string }) => r.applicationId === reviewApplication,
      );
      const fields = (item?.flaggedFields ?? []) as { field: string }[];
      expect(fields.map((f) => f.field)).not.toContain('skills[1]');
    });

    /** Gap 3 rule 1 — arbitrary keys rejected. */
    it('rejects an unknown field path', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/parsed-profiles/${reviewProfile}`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ fields: { salary_expectation: { value: 1, confirmed: true } } })
        .expect(400);

      expect(response.body.detail).toMatch(/Unknown field path/i);
    });

    it('rejects an empty correction set', async () => {
      await request(app.getHttpServer())
        .patch(`/parsed-profiles/${reviewProfile}`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ fields: {} })
        .expect(400);
    });

    /** FR2.2 — the candidate may correct their own auto-filled data. */
    it('the owning candidate may correct their own profile', async () => {
      await request(app.getHttpServer())
        .patch(`/parsed-profiles/${reviewProfile}`)
        .set(auth(await tokenFor(candidateA)))
        .send({ fields: { 'education[0].degree': { value: 'B.Tech CSE', confirmed: true } } })
        .expect(200);
    });

    it('a Hiring Manager cannot correct anything (§24.2)', async () => {
      await request(app.getHttpServer())
        .patch(`/parsed-profiles/${reviewProfile}`)
        .set(auth(await tokenFor(hmA)))
        .send({ fields: { 'skills[0]': { value: 'x', confirmed: true } } })
        .expect(403);
    });

    it('404s a recruiter from another tenant', async () => {
      await request(app.getHttpServer())
        .patch(`/parsed-profiles/${reviewProfile}`)
        .set(auth(await tokenFor(recruiterB)))
        .send({ fields: { 'skills[0]': { value: 'x', confirmed: true } } })
        .expect(404);
    });

    it('audits the correction', async () => {
      await request(app.getHttpServer())
        .patch(`/parsed-profiles/${reviewProfile}`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ fields: { 'skills[0]': { value: 'Python', confirmed: true } } })
        .expect(200);

      const row = await owner.auditLog.findFirstOrThrow({
        where: { resourceId: reviewProfile, action: 'parsed_profile.corrected' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.actorId).toBe(recruiterA);
    });
  });
});
