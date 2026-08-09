import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JobStatus, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AiModule } from './ai.module';
import { AiScoringPort } from './ai-scoring.port';
import {
  ALLOWED_FEATURE_KEYS,
  assertAllowedFeatures,
  isAllowedFeature,
} from './feature-allow-list';
import { ApplicationsModule } from '../applications/applications.module';
import { ApplicationsService } from '../applications/applications.service';
import { AuditService } from '../../common/audit/audit.service';
import { CommonModule } from '../../common/common.module';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { CandidateOwnershipGuard } from '../../common/guards/candidate-ownership.guard';
import { JobAssignmentGuard } from '../../common/guards/job-assignment.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';
import { CorrelationIdInterceptor } from '../../common/interceptors/correlation-id.interceptor';
import { CorrelationIdMiddleware } from '../../common/middleware/correlation-id.middleware';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TokenService } from '../auth/token.service';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * M2.9 Steps 2-4 — score rendering, FR4.3 override, BR-02 and BR-07.
 *
 * Phase 2 generates no scores, so the override endpoint's live answer is
 * always 404. Everything around it — role matrix, tenancy, BR-03 validation,
 * audit wiring — is real and tested here. The success path is exercised by
 * inserting a match_score directly as the OWNER, which is the only way a row
 * can exist at all in Phase 2 and is exactly what Phase 3 will produce.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('AI score override and guarantees (FR4.3, BR-02, BR-07)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let jobs: JobsService;
  let applications: ApplicationsService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;
  const userIds: string[] = [];

  let companyA = '';
  let companyB = '';
  let recruiterA = '';
  let adminA = '';
  let hmA = '';
  let recruiterB = '';
  let candidateUser = '';
  let jobA = '';
  let jobB = '';
  let modelVersionId = '';

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

  async function newApplication(tag: string, job = jobA): Promise<string> {
    const result = await applications.submit(
      { jobId: job, fullName: `AI ${tag}`, email: `${tag}.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
    return result.application.id;
  }

  /** A Phase-3-shaped score row, written as the owner. */
  async function giveScore(applicationId: string, composite = 0.8734) {
    return owner.matchScore.create({
      data: {
        applicationId,
        modelVersionId,
        compositeScore: new Prisma.Decimal(composite),
        rationale: {
          summary: 'Strong match on required skills.',
          factors: [{ feature: 'skill_overlap', contribution: 0.31, direction: 'positive' }],
        },
        featureVector: { skill_overlap: 0.82, semantic_similarity: 0.74 },
      },
    });
  }

  function overrideScore(applicationId: string, body: object, token: string) {
    return request(app.getHttpServer())
      .patch(`/applications/${applicationId}/score`)
      .set(auth(token))
      .send(body);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
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

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `AiA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `AiB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local` },
      });
      userIds.push(user.id);
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'ai-rec-a');
    adminA = await makeUser(companyA, UserRole.ADMIN, 'ai-admin-a');
    hmA = await makeUser(companyA, UserRole.HIRING_MANAGER, 'ai-hm-a');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'ai-rec-b');
    candidateUser = await makeUser(companyA, UserRole.CANDIDATE, 'ai-cand');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `ai-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: recruiterB,
      email: `ai-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    const created = await jobs.create(recA, { title: `Ai job ${suffix}` });
    await jobs.update(recA, created.id, { status: JobStatus.PUBLISHED });
    jobA = created.id;

    const createdB = await jobs.create(recB, { title: `Ai jobB ${suffix}` });
    await jobs.update(recB, createdB.id, { status: JobStatus.PUBLISHED });
    jobB = createdB.id;

    const model = await owner.aiModelVersion.findFirst();
    if (!model) throw new Error('No ai_model_versions row. Run `pnpm prisma:seed` first.');
    modelVersionId = model.id;
  });

  afterAll(async () => {
    try {
      const applicationIds = (
        await owner.application.findMany({
          where: { job: { companyId: { in: [companyA, companyB] } } },
          select: { id: true },
        })
      ).map((row) => row.id);

      await owner.matchScore.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.stageHistory.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await owner.auditLog.deleteMany({ where: { resourceId: { in: applicationIds } } });
      await owner.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
      await owner.candidate.deleteMany({ where: { email: { contains: suffix } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  // =========================================================================
  // Step 2 — NotScored rendering
  // =========================================================================
  describe('NotScored rendering (FR4.5, Handoff §G)', () => {
    it('GET /jobs/:id/candidates renders score: null through the seam', async () => {
      await newApplication('render1');

      const response = await request(app.getHttpServer())
        .get(`/jobs/${jobA}/candidates?limit=100`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
      for (const row of response.body.data) {
        expect(row).toHaveProperty('score');
        expect(row.score).toBeNull();
      }
    });

    it('GET /applications/:id renders score: null', async () => {
      const id = await newApplication('render2');

      const response = await request(app.getHttpServer())
        .get(`/applications/${id}`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(response.body).toHaveProperty('score');
      expect(response.body.score).toBeNull();
    });

    /**
     * Phase 3 renders the persisted score. In Phase 2 this asserted the
     * opposite — the null provider withheld it — and the flip is the seam
     * doing its job: one binding changed, no consumer did.
     */
    it('renders the persisted score once one exists', async () => {
      const id = await newApplication('render3');
      await giveScore(id, 0.8734);

      const response = await request(app.getHttpServer())
        .get(`/applications/${id}`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(response.body.score).not.toBeNull();
      expect(response.body.score.composite).toBeCloseTo(0.8734, 4);
      // BR-02 — a score never reaches the wire without its explanation.
      expect(response.body.score.rationale.summary).toBeTruthy();
    });

    /** PRD §24.2 Table 24.1 — "View AI rankings + rationale: Candidate —". */
    it('§24.2: a candidate never receives the score, even once one exists', async () => {
      const id = await newApplication('render4');
      await giveScore(id);
      const candidate = await prisma.application.findUniqueOrThrow({
        where: { id },
        select: { candidateId: true },
      });
      await prisma.candidate.update({
        where: { id: candidate.candidateId },
        data: { userId: candidateUser },
      });

      const response = await request(app.getHttpServer())
        .get(`/applications/${id}`)
        .set(auth(await tokenFor(candidateUser)))
        .expect(200);

      expect(response.body.score).toBeNull();
      expect(JSON.stringify(response.body)).not.toContain('rationale');
      expect(JSON.stringify(response.body)).not.toContain('featureVector');
    });
  });

  // =========================================================================
  // Step 3 — FR4.3 override
  // =========================================================================
  describe('PATCH /applications/:id/score', () => {
    it('404s when no score exists — the Phase 2 reality', async () => {
      const id = await newApplication('ov-none');

      await overrideScore(
        id,
        { overrideScore: 0.5, reason: 'Better than ranked' },
        await tokenFor(recruiterA),
      ).expect(404);
    });

    it('never creates a score row on a 404', async () => {
      const id = await newApplication('ov-nocreate');

      await overrideScore(
        id,
        { overrideScore: 0.5, reason: 'x' },
        await tokenFor(recruiterA),
      ).expect(404);

      await expect(owner.matchScore.count({ where: { applicationId: id } })).resolves.toBe(0);
    });

    it('overrides an existing score and preserves the original', async () => {
      const id = await newApplication('ov-ok');
      await giveScore(id, 0.8734);

      const response = await overrideScore(
        id,
        { overrideScore: 0.42, reason: 'Interview contradicted the ranking' },
        await tokenFor(recruiterA),
      ).expect(200);

      expect(response.body).toMatchObject({
        applicationId: id,
        overridden: true,
        overriddenBy: recruiterA,
        originalScore: 0.8734,
        overrideScore: 0.42,
      });

      // PRD §15.4 — the override does not replace the AI value.
      const row = await owner.matchScore.findFirstOrThrow({ where: { applicationId: id } });
      expect(Number(row.compositeScore)).toBe(0.8734);
      expect(row.overriddenBy).toBe(recruiterA);
      expect(row.overrideReason).toBe('Interview contradicted the ranking');
    });

    it('an Admin may override', async () => {
      const id = await newApplication('ov-admin');
      await giveScore(id);

      await overrideScore(
        id,
        { overrideScore: 0.3, reason: 'Admin call' },
        await tokenFor(adminA),
      ).expect(200);
    });

    it('BR-03: writes score.overridden carrying the reason', async () => {
      const id = await newApplication('ov-audit');
      const score = await giveScore(id);

      await overrideScore(
        id,
        { overrideScore: 0.2, reason: 'Portfolio outweighs the score' },
        await tokenFor(recruiterA),
      ).expect(200);

      const row = await owner.auditLog.findFirstOrThrow({
        where: { resourceId: score.id, action: 'score.overridden' },
      });

      expect(row.resourceType).toBe('match_score');
      expect(row.actorId).toBe(recruiterA);
      expect(row.beforeState).toMatchObject({ overridden: false });
      expect(row.afterState).toMatchObject({
        overridden: true,
        overrideReason: 'Portfolio outweighs the score',
        overrideScore: 0.2,
      });
    });

    // ---- validation (BR-03) ---------------------------------------------

    it('BR-03: rejects a missing reason', async () => {
      const id = await newApplication('ov-noreason');
      await giveScore(id);

      const response = await overrideScore(
        id,
        { overrideScore: 0.5 },
        await tokenFor(recruiterA),
      ).expect(400);
      expect(response.body.detail).toMatch(/reason is required/i);
    });

    it('BR-03: rejects an empty reason', async () => {
      const id = await newApplication('ov-blank');
      await giveScore(id);

      await overrideScore(
        id,
        { overrideScore: 0.5, reason: '' },
        await tokenFor(recruiterA),
      ).expect(400);
    });

    it('rejects a score outside 0..1, matching the database CHECK', async () => {
      const id = await newApplication('ov-range');
      await giveScore(id);
      const token = await tokenFor(recruiterA);

      const high = await overrideScore(id, { overrideScore: 1.5, reason: 'x' }, token).expect(400);
      expect(high.body.detail).toMatch(/between 0 and 1/i);
      await overrideScore(id, { overrideScore: -0.1, reason: 'x' }, token).expect(400);
    });

    it('rejects an attempt to attribute the override to someone else', async () => {
      const id = await newApplication('ov-spoof');
      await giveScore(id);

      await overrideScore(
        id,
        { overrideScore: 0.5, reason: 'x', overriddenBy: adminA },
        await tokenFor(recruiterA),
      ).expect(400);
    });

    it('rejects a malformed application id', async () => {
      await request(app.getHttpServer())
        .patch('/applications/not-a-uuid/score')
        .set(auth(await tokenFor(recruiterA)))
        .send({ overrideScore: 0.5, reason: 'x' })
        .expect(400);
    });

    // ---- authorisation ---------------------------------------------------

    it('requires authentication', async () => {
      const id = await newApplication('ov-anon');

      await request(app.getHttpServer())
        .patch(`/applications/${id}/score`)
        .send({ overrideScore: 0.5, reason: 'x' })
        .expect(401);
    });

    it('§24.2: refuses a Hiring Manager', async () => {
      const id = await newApplication('ov-hm');
      await giveScore(id);

      await overrideScore(id, { overrideScore: 0.5, reason: 'x' }, await tokenFor(hmA)).expect(403);

      const row = await owner.matchScore.findFirstOrThrow({ where: { applicationId: id } });
      expect(row.overriddenBy).toBeNull();
    });

    it('refuses a Candidate', async () => {
      const id = await newApplication('ov-cand');
      await giveScore(id);

      await overrideScore(
        id,
        { overrideScore: 0.5, reason: 'x' },
        await tokenFor(candidateUser),
      ).expect(403);
    });

    it('BR-06: a Recruiter from another tenant gets 404 and changes nothing', async () => {
      const id = await newApplication('ov-cross');
      await giveScore(id);

      await overrideScore(
        id,
        { overrideScore: 0.1, reason: 'x' },
        await tokenFor(recruiterB),
      ).expect(404);

      const row = await owner.matchScore.findFirstOrThrow({ where: { applicationId: id } });
      expect(row.overriddenBy).toBeNull();
    });

    it('a scored foreign application is indistinguishable from an unscored one', async () => {
      const scoredForeign = await newApplication('ov-fs', jobB);
      await giveScore(scoredForeign);
      const unscoredOwn = await newApplication('ov-uo');
      const token = await tokenFor(recruiterA);

      const foreign = await overrideScore(
        scoredForeign,
        { overrideScore: 0.5, reason: 'x' },
        token,
      ).expect(404);
      const unscored = await overrideScore(
        unscoredOwn,
        { overrideScore: 0.5, reason: 'x' },
        token,
      ).expect(404);

      expect(foreign.body.detail).toBe(unscored.body.detail);
      expect(foreign.body.title).toBe(unscored.body.title);
    });
  });

  // =========================================================================
  // Step 4 — BR-02 and BR-07
  // =========================================================================
  describe('BR-02 — no score without a rationale', () => {
    /**
     * The column list itself, read from the catalogue.
     *
     * Prisma's raw path reports only SQLSTATE 23502 and strips the column
     * name, so the insert tests below prove THAT the database refused while
     * this one proves WHICH columns it refuses to leave empty — together
     * that is the BR-02 / FR4.4 guarantee.
     */
    it('rationale, feature_vector and model_version_id are NOT NULL in the database', async () => {
      const columns = await owner.$queryRawUnsafe<{ column_name: string; is_nullable: string }[]>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'match_scores'
           AND column_name IN ('rationale', 'feature_vector', 'model_version_id', 'composite_score')`,
      );

      expect(columns).toHaveLength(4);
      for (const column of columns) {
        expect(`${column.column_name}=${column.is_nullable}`).toBe(`${column.column_name}=NO`);
      }
    });

    it('BR-02: the DATABASE refuses a match_score with no rationale', async () => {
      const id = await newApplication('br02-db');

      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO match_scores (id, application_id, model_version_id, composite_score, feature_vector, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 0.5, '{}'::jsonb, now(), now())`,
          id,
          modelVersionId,
        ),
        // 23502 = not_null_violation.
      ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23502' } });

      await expect(owner.matchScore.count({ where: { applicationId: id } })).resolves.toBe(0);
    });

    it('FR4.4: the database refuses a score with no feature vector', async () => {
      const id = await newApplication('br02-fv');

      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO match_scores (id, application_id, model_version_id, composite_score, rationale, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 0.5, '{}'::jsonb, now(), now())`,
          id,
          modelVersionId,
        ),
      ).rejects.toMatchObject({ meta: { code: '23502' } });
    });

    it('FR4.4: the database refuses a score with no model version', async () => {
      const id = await newApplication('br02-mv');

      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO match_scores (id, application_id, composite_score, rationale, feature_vector, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, 0.5, '{}'::jsonb, '{}'::jsonb, now(), now())`,
          id,
        ),
      ).rejects.toMatchObject({ meta: { code: '23502' } });
    });

    it('enforces the composite_score range at the database', async () => {
      const id = await newApplication('br02-range');

      await expect(
        owner.matchScore.create({
          data: {
            applicationId: id,
            modelVersionId,
            compositeScore: new Prisma.Decimal(1.5),
            rationale: { summary: 's', factors: [] },
            featureVector: {},
          },
        }),
      ).rejects.toThrow();
    });

    /**
     * Handoff §G: "if rationale generation fails, the transaction aborts — no
     * partial row". Simulated by failing after the insert inside one
     * transaction; nothing may survive.
     */
    it('no partial score survives a failed transaction', async () => {
      const id = await newApplication('br02-atomic');

      await expect(
        owner.$transaction(async (tx) => {
          await tx.matchScore.create({
            data: {
              applicationId: id,
              modelVersionId,
              compositeScore: new Prisma.Decimal(0.5),
              rationale: { summary: 's', factors: [] },
              featureVector: {},
            },
          });
          throw new Error('rationale generation failed');
        }),
      ).rejects.toThrow('rationale generation failed');

      await expect(owner.matchScore.count({ where: { applicationId: id } })).resolves.toBe(0);
    });
  });

  describe('BR-07 — Table 19.1 feature allow-list', () => {
    it('contains exactly the six Table 19.1 features', () => {
      expect(ALLOWED_FEATURE_KEYS).toHaveLength(6);
    });

    it('matches the six identifiers Handoff Gap 2 prints verbatim', () => {
      for (const key of [
        'semantic_similarity',
        'skill_overlap',
        'years_experience_delta',
        'education_match',
        'recency_relevant_exp',
        'certification_match',
      ]) {
        expect(isAllowedFeature(key)).toBe(true);
      }
    });

    /** The two M2.9 guessed wrong. Pinned so they cannot creep back. */
    it('rejects the provisional names M2.9 used by mistake', () => {
      expect(isAllowedFeature('education_level_match')).toBe(false);
      expect(isAllowedFeature('certification_match_count')).toBe(false);
    });

    it('accepts a feature vector built only from allowed keys', () => {
      expect(() =>
        assertAllowedFeatures({ skill_overlap: 0.8, semantic_similarity: 0.7 }),
      ).not.toThrow();
    });

    /** PRD §19.3's explicit exclusion list — the reason BR-07 exists. */
    it('rejects every protected attribute named in §19.3', () => {
      for (const key of [
        'name',
        'gender',
        'age',
        'date_of_birth',
        'address',
        'nationality',
        'institution_prestige_ranking',
        'photograph',
      ]) {
        expect(isAllowedFeature(key)).toBe(false);
        expect(() => assertAllowedFeatures({ [key]: 1 })).toThrow(/BR-07/);
      }
    });

    it('rejects institution NAME — a socio-economic proxy (§19.3)', () => {
      expect(() => assertAllowedFeatures({ institution_name: 'X' })).toThrow(/BR-07/);
    });

    it('rejects an unknown key even alongside valid ones', () => {
      expect(() => assertAllowedFeatures({ skill_overlap: 0.8, postcode: 'SW1' })).toThrow(
        /postcode/,
      );
    });

    it('does not disclose the allowed set in the error', () => {
      try {
        assertAllowedFeatures({ gender: 1 });
        throw new Error('expected a rejection');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('gender');
        expect(message).not.toContain('skill_overlap');
      }
    });

    it('an empty feature vector is not a violation', () => {
      expect(() => assertAllowedFeatures({})).not.toThrow();
    });
  });

  // =========================================================================
  // BR-01 — no AI path may move a stage
  // =========================================================================
  describe('BR-01 — the AI surface cannot transition a stage', () => {
    it('overriding a score leaves the stage untouched', async () => {
      const id = await newApplication('br01');
      await giveScore(id);

      await overrideScore(
        id,
        { overrideScore: 0.01, reason: 'Very weak' },
        await tokenFor(recruiterA),
      ).expect(200);

      const application = await owner.application.findUniqueOrThrow({ where: { id } });
      expect(application.currentStage).toBe('Applied');
      await expect(owner.stageHistory.count({ where: { applicationId: id } })).resolves.toBe(0);
    });

    it('the port exposes no method that could move a stage', async () => {
      const moduleRef = await Test.createTestingModule({
        // CommonModule is @Global in the running app; an isolated test
        // module has to import it for ScoreOverrideService's Prisma.
        imports: [
          ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
          CommonModule,
          AiModule,
        ],
      }).compile();
      const port = moduleRef.get(AiScoringPort);

      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(port))
        .filter((name) => name !== 'constructor')
        .sort();

      // Nothing here can reach a stage. BR-01 holds because the surface is
      // this small, not because implementations are trusted to behave.
      expect(methods).toEqual(['getScore', 'requestParse']);
      await moduleRef.close();
    });
  });
});
