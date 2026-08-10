import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ApplicationSource, JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AnalyticsModule } from './analytics.module';
import type { FunnelSource, FunnelStage } from './analytics.service';
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
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TokenService } from '../auth/token.service';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * FR7.1–FR7.2 — the hiring funnel.
 *
 * The fixture is built so every expected number can be checked by hand
 * against the comment above it. Stage history is written directly rather than
 * through the pipeline endpoint, so the timestamps are exact and the
 * durations are not at the mercy of how long the test takes to run.
 *
 * FR7.3 (source-of-hire) has no test because it has no implementation and no
 * data: no source column, capture point or attribution rule is specified
 * anywhere. It is recorded as an open gap rather than estimated.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('Analytics funnel (FR7.1, FR7.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;

  let companyA = '';
  let companyB = '';
  let recruiterA = '';
  let adminA = '';
  let hmA = '';
  let candidateA = '';
  let recruiterB = '';
  let jobA = '';
  let jobB = '';
  let jobOtherTenant = '';

  /** Fixed base so every duration below is exact. */
  const T0 = new Date('2026-03-01T09:00:00.000Z');
  const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

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

  const funnel = (token: string, query: Record<string, string> = {}) =>
    request(app.getHttpServer()).get('/analytics/funnel').query(query).set(auth(token));

  const stageOf = (body: { stages: FunnelStage[] }, name: string): FunnelStage =>
    body.stages.find((s) => s.name === name)!;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        NotificationsModule,
        AuthModule,
        JobsModule,
        ApplicationsModule,
        AnalyticsModule,
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
    tokens = moduleRef.get(TokenService);
    const jobs = moduleRef.get(JobsService);
    const applications = moduleRef.get(ApplicationsService);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `AnA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `AnB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
      });
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'an-rec-a');
    adminA = await makeUser(companyA, UserRole.ADMIN, 'an-adm-a');
    hmA = await makeUser(companyA, UserRole.HIRING_MANAGER, 'an-hm-a');
    candidateA = await makeUser(companyA, UserRole.CANDIDATE, 'an-cand-a');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'an-rec-b');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `an-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: recruiterB,
      email: `an-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    for (const [label, actor, target] of [
      ['A', recA, 'jobA'],
      ['B', recA, 'jobB'],
      ['X', recB, 'jobOtherTenant'],
    ] as const) {
      const created = await jobs.create(actor, { title: `An job ${label} ${suffix}` });
      await jobs.update(actor, created.id, { status: JobStatus.PUBLISHED });
      if (target === 'jobA') jobA = created.id;
      if (target === 'jobB') jobB = created.id;
      if (target === 'jobOtherTenant') jobOtherTenant = created.id;
    }

    /**
     * Build one application with a known history.
     *
     * `appliedAt` and each transition timestamp are written directly, so the
     * arithmetic in the assertions is exact.
     */
    async function seed(
      jobId: string,
      name: string,
      appliedOffset: number,
      transitions: { to: string; atOffset: number }[],
      source?: ApplicationSource,
    ): Promise<string> {
      const { application } = await applications.submit(
        { jobId, fullName: name, email: `${name.replace(/\W/g, '')}.${suffix}@test.local`, source },
        pdf(),
        CORRELATION,
      );

      await owner.application.update({
        where: { id: application.id },
        data: { appliedAt: at(appliedOffset) },
      });

      let from = application.currentStage;
      for (const transition of transitions) {
        await owner.stageHistory.create({
          data: {
            applicationId: application.id,
            fromStage: from,
            toStage: transition.to,
            changedBy: recruiterA,
            changedAt: at(transition.atOffset),
          },
        });
        from = transition.to;
      }
      await owner.application.update({
        where: { id: application.id },
        data: { currentStage: from },
      });

      return application.id;
    }

    /*
     * Job A — four applications, all applied at T0.
     *
     *  a1  Applied →(24h) Screening →(48h) Interview →(72h) Hired
     *        stays: Applied 24h, Screening 24h, Interview 24h. Hired: 72h = 3d
     *  a2  Applied →(48h) Screening →(96h) Rejected
     *        stays: Applied 48h, Screening 48h
     *  a3  Applied →(12h) Screening            (still there — stay not counted)
     *        stays: Applied 12h
     *  a4  Applied                             (never moved — nothing counted)
     *
     * Reached:  Applied 4 · Screening 3 · Interview 1 · Hired 1 · Rejected 1
     * Currently: Applied 1 · Screening 1 · Hired 1 · Rejected 1
     * Avg Applied stay   = (24 + 48 + 12) / 3 = 28h
     * Avg Screening stay = (24 + 48) / 2      = 36h
     * Avg Interview stay = 24h
     */
    /*
     * FR7.3 sources on the same fixture, chosen so every figure is checkable
     * by hand:
     *
     *   Job A   referral    2 applications, 1 hire  → hireRate 0.5
     *           job_board   1 application,  0 hires → hireRate 0
     *           career_site 0 applications          → hireRate null
     *           other       0 applications          → hireRate null
     *           notRecorded 1 (An Four answered nothing)
     *
     *   Job B   career_site 1 application, 1 hire   → hireRate 1
     *
     * Tenant-wide: recorded 4, notRecorded 1, and referral + career_site
     * hires total 2 — which must equal timeToHire.hiredCount.
     */
    await seed(
      jobA,
      'An One',
      0,
      [
        { to: 'Screening', atOffset: 24 * HOUR },
        { to: 'Interview', atOffset: 48 * HOUR },
        { to: 'Hired', atOffset: 72 * HOUR },
      ],
      ApplicationSource.referral,
    );
    await seed(
      jobA,
      'An Two',
      0,
      [
        { to: 'Screening', atOffset: 48 * HOUR },
        { to: 'Rejected', atOffset: 96 * HOUR },
      ],
      ApplicationSource.referral,
    );
    await seed(
      jobA,
      'An Three',
      0,
      [{ to: 'Screening', atOffset: 12 * HOUR }],
      ApplicationSource.job_board,
    );
    // Deliberately no source — the notRecorded case.
    await seed(jobA, 'An Four', 0, []);

    /*
     * Job B — one application, applied 100 days later so a date filter can
     * separate the two jobs cleanly. Hired after 5 days.
     */
    await seed(
      jobB,
      'An Five',
      100 * DAY,
      [{ to: 'Hired', atOffset: 105 * DAY }],
      ApplicationSource.career_site,
    );

    // Another tenant's job — must never appear in company A's funnel.
    await seed(jobOtherTenant, 'An Foreign', 0, [{ to: 'Hired', atOffset: 10 * DAY }]);
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

      await owner.stageHistory.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
      await owner.candidate.deleteMany({ where: { email: { contains: suffix } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  describe('FR7.1 — conversion rates by stage', () => {
    it('counts every application that was ever in a stage, not just those there now', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), { jobId: jobA }).expect(200);

      expect(body.totalApplications).toBe(4);
      expect(stageOf(body, 'Applied')).toMatchObject({ reached: 4, currentlyHere: 1 });
      expect(stageOf(body, 'Screening')).toMatchObject({ reached: 3, currentlyHere: 1 });
      expect(stageOf(body, 'Interview')).toMatchObject({ reached: 1, currentlyHere: 0 });
      expect(stageOf(body, 'Hired')).toMatchObject({ reached: 1, currentlyHere: 1 });
      expect(stageOf(body, 'Rejected')).toMatchObject({ reached: 1, currentlyHere: 1 });
    });

    it('converts against the previous stage and against the start', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), { jobId: jobA }).expect(200);

      // Applied is first: nothing precedes it.
      expect(stageOf(body, 'Applied').conversionFromPrevious).toBeNull();
      expect(stageOf(body, 'Applied').conversionFromStart).toBe(1);

      // Screening 3 of Applied 4.
      expect(stageOf(body, 'Screening').conversionFromPrevious).toBe(0.75);
      expect(stageOf(body, 'Screening').conversionFromStart).toBe(0.75);

      // Interview 1 of Screening 3.
      expect(stageOf(body, 'Interview').conversionFromPrevious).toBeCloseTo(0.3333, 4);
      expect(stageOf(body, 'Interview').conversionFromStart).toBe(0.25);
    });

    it('reports stages in pipeline order with terminal stages flagged', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), { jobId: jobA }).expect(200);

      expect(body.stages.map((s: { name: string }) => s.name)).toEqual([
        'Applied',
        'Screening',
        'Interview',
        'Offer',
        'Hired',
        'Rejected',
      ]);
      expect(stageOf(body, 'Hired').isTerminal).toBe(true);
      expect(stageOf(body, 'Rejected').isTerminal).toBe(true);
      expect(stageOf(body, 'Screening').isTerminal).toBe(false);
    });

    it('a stage nobody reached reports zero, not absence', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), { jobId: jobA }).expect(200);

      expect(stageOf(body, 'Offer')).toMatchObject({
        reached: 0,
        currentlyHere: 0,
        conversionFromStart: 0,
        averageTimeInStageHours: null,
      });
    });
  });

  describe('FR7.2 — time in stage and time to hire', () => {
    it('averages only completed stays', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), { jobId: jobA }).expect(200);

      // (24 + 48 + 12) / 3 = 28. The application still sitting in Applied
      // contributes nothing, because its stay has not ended.
      expect(stageOf(body, 'Applied').averageTimeInStageHours).toBe(28);
      // (24 + 48) / 2 = 36.
      expect(stageOf(body, 'Screening').averageTimeInStageHours).toBe(36);
      expect(stageOf(body, 'Interview').averageTimeInStageHours).toBe(24);
    });

    it('leaves a stage with no completed stay null rather than zero', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), { jobId: jobA }).expect(200);

      // One application is in Hired and has not left it; a 0 here would read
      // as "no time spent", which is a different claim from "not yet known".
      expect(stageOf(body, 'Hired').averageTimeInStageHours).toBeNull();
    });

    it('measures time to hire from applied to entering Hired', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), { jobId: jobA }).expect(200);

      expect(body.timeToHire).toEqual({ hiredCount: 1, averageDays: 3, medianDays: 3 });
    });

    it('reports per role (FR7.2) — job B has its own numbers', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), { jobId: jobB }).expect(200);

      expect(body.jobId).toBe(jobB);
      expect(body.totalApplications).toBe(1);
      expect(body.timeToHire).toEqual({ hiredCount: 1, averageDays: 5, medianDays: 5 });
    });

    it('averages and medians across roles when no job is given', async () => {
      const { body } = await funnel(await tokenFor(recruiterA)).expect(200);

      // Both tenant hires: 3 days (job A) and 5 days (job B).
      expect(body.totalApplications).toBe(5);
      expect(body.timeToHire).toEqual({ hiredCount: 2, averageDays: 4, medianDays: 4 });
    });

    it('reports null time-to-hire when nobody has been hired in range', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), {
        from: '2020-01-01T00:00:00.000Z',
        to: '2020-12-31T00:00:00.000Z',
      }).expect(200);

      expect(body.totalApplications).toBe(0);
      expect(body.timeToHire).toBeNull();
    });
  });

  describe('date range (RC-12)', () => {
    it('filters on applied_at', async () => {
      // Job B's application was submitted 100 days after job A's.
      const { body } = await funnel(await tokenFor(recruiterA), {
        from: new Date(T0.getTime() + 50 * DAY).toISOString(),
      }).expect(200);

      expect(body.totalApplications).toBe(1);
      expect(body.range.from).toBe(new Date(T0.getTime() + 50 * DAY).toISOString());
    });

    it('rejects from after to', async () => {
      await funnel(await tokenFor(recruiterA), {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }).expect(400);
    });

    it('rejects a malformed date', async () => {
      await funnel(await tokenFor(recruiterA), { from: 'last-tuesday' }).expect(400);
    });

    it('rejects an unrecognised filter rather than ignoring it', async () => {
      await funnel(await tokenFor(recruiterA), { stage: 'Screening' }).expect(400);
    });
  });

  describe('RBAC (PRD Table 23.1 — Recruiter, Admin)', () => {
    it('an Administrator may read the funnel', async () => {
      await funnel(await tokenFor(adminA)).expect(200);
    });

    it('a Hiring Manager may not — 403, a role refusal', async () => {
      await funnel(await tokenFor(hmA)).expect(403);
    });

    it('a Candidate may not', async () => {
      await funnel(await tokenFor(candidateA)).expect(403);
    });

    it('an unauthenticated caller may not', async () => {
      await request(app.getHttpServer()).get('/analytics/funnel').expect(401);
    });
  });

  describe('tenant isolation', () => {
    it("never counts another company's applications", async () => {
      const { body } = await funnel(await tokenFor(recruiterA)).expect(200);

      // Company A has 5 applications; the foreign one is a sixth in the table.
      expect(body.totalApplications).toBe(5);
      expect(body.timeToHire.hiredCount).toBe(2);
    });

    it("refuses another company's jobId with 404, not 403 or an empty funnel", async () => {
      await funnel(await tokenFor(recruiterA), { jobId: jobOtherTenant }).expect(404);
    });

    it('gives the other tenant its own separate numbers', async () => {
      const { body } = await funnel(await tokenFor(recruiterB)).expect(200);

      expect(body.totalApplications).toBe(1);
      expect(body.timeToHire).toEqual({ hiredCount: 1, averageDays: 10, medianDays: 10 });
    });

    it('a jobId that does not exist is refused the same way as a foreign one', async () => {
      const token = await tokenFor(recruiterA);
      const foreign = await funnel(token, { jobId: jobOtherTenant }).expect(404);
      const absent = await funnel(token, { jobId: randomUUID() }).expect(404);

      /*
       * `correlationId` is unique per request (NFR11) and `instance` echoes
       * the request URL, which necessarily carries the caller's own jobId.
       * Neither can distinguish the two cases for an attacker, because both
       * are values the caller already supplied or can predict. Everything
       * else must be byte-identical, or the shape of the refusal would answer
       * "does this job exist in another tenant?" (BR-06).
       */
      const strip = (body: Record<string, unknown>) => {
        const { correlationId: _correlationId, instance: _instance, ...rest } = body;
        return rest;
      };
      expect(strip(foreign.body)).toEqual(strip(absent.body));
      expect(foreign.status).toBe(absent.status);
    });
  });

  describe('FR7.3 — source of hire', () => {
    const bySource = (body: { sourceOfHire: { bySource: FunnelSource[] } }, name: string) =>
      body.sourceOfHire.bySource.find((s) => s.source === name)!;

    it('reports the block alongside the existing funnel fields', async () => {
      const { body } = await funnel(await tokenFor(recruiterA)).expect(200);

      expect(Object.keys(body).sort()).toEqual([
        'jobId',
        'range',
        'sourceOfHire',
        'stages',
        'timeToHire',
        'totalApplications',
      ]);
    });

    it('counts applications and hires per channel, tenant-wide', async () => {
      const { body } = await funnel(await tokenFor(recruiterA)).expect(200);

      expect(bySource(body, 'referral')).toEqual({
        source: 'referral',
        applications: 2,
        hires: 1,
        hireRate: 0.5,
      });
      expect(bySource(body, 'job_board')).toEqual({
        source: 'job_board',
        applications: 1,
        hires: 0,
        hireRate: 0,
      });
      expect(bySource(body, 'career_site')).toEqual({
        source: 'career_site',
        applications: 1,
        hires: 1,
        hireRate: 1,
      });
    });

    it('lists a channel nobody used with zeros and a null rate, not absence', async () => {
      const { body } = await funnel(await tokenFor(recruiterA)).expect(200);

      expect(bySource(body, 'other')).toEqual({
        source: 'other',
        applications: 0,
        hires: 0,
        // Null, not 0 — a rate over an empty denominator is unknown.
        hireRate: null,
      });
    });

    it('reports every approved value and nothing else', async () => {
      const { body } = await funnel(await tokenFor(recruiterA)).expect(200);

      expect(body.sourceOfHire.bySource.map((s: FunnelSource) => s.source).sort()).toEqual([
        'career_site',
        'job_board',
        'other',
        'referral',
      ]);
    });

    /** D30 — the whole point: a coverage gap must not read as a channel. */
    it('counts a missing source only in notRecorded, never as `other`', async () => {
      const { body } = await funnel(await tokenFor(recruiterA)).expect(200);

      expect(body.sourceOfHire.notRecorded).toBe(1);
      expect(bySource(body, 'other').applications).toBe(0);
    });

    it('recorded + notRecorded always equals totalApplications', async () => {
      const { body } = await funnel(await tokenFor(recruiterA)).expect(200);

      expect(body.sourceOfHire.recorded).toBe(4);
      expect(body.sourceOfHire.notRecorded).toBe(1);
      expect(body.sourceOfHire.recorded + body.sourceOfHire.notRecorded).toBe(
        body.totalApplications,
      );
    });

    /** D32 — the two hire figures share one definition and cannot diverge. */
    it('hires across sources agree with timeToHire.hiredCount', async () => {
      const { body } = await funnel(await tokenFor(recruiterA)).expect(200);

      const totalHires = body.sourceOfHire.bySource.reduce(
        (sum: number, s: FunnelSource) => sum + s.hires,
        0,
      );
      expect(totalHires).toBe(body.timeToHire.hiredCount);
      expect(totalHires).toBe(2);
    });

    it('scopes to one role when jobId is given (FR7.2 + FR7.3)', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), { jobId: jobA }).expect(200);

      expect(body.sourceOfHire.recorded).toBe(3);
      expect(body.sourceOfHire.notRecorded).toBe(1);
      expect(bySource(body, 'referral')).toMatchObject({ applications: 2, hires: 1 });
      // Job B's career_site application is not in this job's numbers.
      expect(bySource(body, 'career_site')).toMatchObject({ applications: 0, hireRate: null });
    });

    it('respects the date filter', async () => {
      // Only job B's application falls after this cutoff.
      const { body } = await funnel(await tokenFor(recruiterA), {
        from: new Date(T0.getTime() + 50 * DAY).toISOString(),
      }).expect(200);

      expect(body.sourceOfHire.recorded).toBe(1);
      expect(body.sourceOfHire.notRecorded).toBe(0);
      expect(bySource(body, 'career_site')).toMatchObject({ applications: 1, hires: 1 });
      expect(bySource(body, 'referral')).toMatchObject({ applications: 0, hires: 0 });
    });

    it("never counts another tenant's sources", async () => {
      const { body } = await funnel(await tokenFor(recruiterB)).expect(200);

      // Company B's single application was seeded without a source.
      expect(body.sourceOfHire.recorded).toBe(0);
      expect(body.sourceOfHire.notRecorded).toBe(1);
      for (const entry of body.sourceOfHire.bySource as FunnelSource[]) {
        expect(entry.applications).toBe(0);
      }
    });

    it('is empty but well-formed when the range holds no applications', async () => {
      const { body } = await funnel(await tokenFor(recruiterA), {
        from: '2020-01-01T00:00:00.000Z',
        to: '2020-12-31T00:00:00.000Z',
      }).expect(200);

      expect(body.sourceOfHire.recorded).toBe(0);
      expect(body.sourceOfHire.notRecorded).toBe(0);
      expect(body.sourceOfHire.bySource).toHaveLength(4);
      expect(bySource(body, 'referral').hireRate).toBeNull();
    });
  });

  describe('audit', () => {
    it('writes no record — reading a dashboard changes no state', async () => {
      const before = await owner.auditLog.count({ where: { companyId: companyA } });
      await funnel(await tokenFor(recruiterA)).expect(200);

      expect(await owner.auditLog.count({ where: { companyId: companyA } })).toBe(before);
    });
  });
});
