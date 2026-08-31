import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JobStatus, UserRole } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
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
import { AiModule } from '../ai/ai.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ApplicationsModule } from '../applications/applications.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { TokenService } from '../auth/token.service';
import { CalendarModule } from '../calendar/calendar.module';
import { InterviewsModule } from '../interviews/interviews.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ScorecardsModule } from '../scorecards/scorecards.module';
import { TagsModule } from '../tags/tags.module';
import { JobsModule } from './jobs.module';
import type { NextFunction, Response } from 'express';
import type { RequestContext } from '../../common/types/authenticated-request';

/**
 * §24.2 — the Hiring Manager's real reach, asserted end to end.
 *
 * WHY THIS SPEC EXISTS. The HM console gates its navigation and hides
 * recruiter controls, but a route table is not an authorization boundary — a
 * Hiring Manager can type any URL, and the only thing that actually stops them
 * is the API. `apps/web` has no test harness (its `test` script is a stub and
 * adding one would mean new dependencies), so these tests stand in for the
 * frontend ones: each refusal below is the reason a control is absent from the
 * HM screens, and each allowance is a panel those screens render.
 *
 * If any REFUSED case ever starts returning 2xx, the corresponding UI omission
 * has silently become the only thing protecting that data.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Hiring Manager access surface (§24.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  let companyId = '';
  let recruiter = '';
  let hm = '';
  let assignedJob = '';
  let unassignedJob = '';
  let applicationId = '';
  let hmToken = '';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());

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
        AiModule,
        PipelineModule,
        ScorecardsModule,
        TagsModule,
        CalendarModule,
        InterviewsModule,
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

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const company = await prisma.company.create({
      data: { name: `HMA ${suffix}`, dataRegion: 'test' },
    });
    companyId = company.id;

    const mk = async (role: UserRole, tag: string) =>
      (
        await prisma.users.create({
          data: { companyId, role, email: `hma-${tag}.${suffix}@test.local`, passwordHash: 'x' },
        })
      ).id;

    recruiter = await mk(UserRole.RECRUITER, 'rec');
    hm = await mk(UserRole.HIRING_MANAGER, 'hm');

    const mkJob = async (tag: string) =>
      (
        await prisma.job.create({
          data: {
            companyId,
            createdBy: recruiter,
            title: `HMA ${tag} ${suffix}`,
            status: JobStatus.PUBLISHED,
          },
        })
      ).id;

    assignedJob = await mkJob('assigned');
    unassignedJob = await mkJob('unassigned');

    await prisma.jobAssignment.create({ data: { jobId: assignedJob, userId: hm } });

    const candidate = await prisma.candidate.create({
      data: { fullName: 'Review Target', email: `hma-cand.${suffix}@test.local` },
    });
    applicationId = (
      await prisma.application.create({
        data: { jobId: assignedJob, candidateId: candidate.id, currentStage: 'Applied' },
      })
    ).id;

    const user = await prisma.users.findUniqueOrThrow({ where: { id: hm } });
    hmToken = await tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    });
  });

  afterAll(async () => {
    // A failed bootstrap leaves these undefined; guarding keeps the real
    // compile error visible instead of burying it under a teardown TypeError.
    if (!owner) {
      await app?.close();
      return;
    }
    try {
      /*
       * Author/actor columns are ON DELETE RESTRICT, so everything this run
       * wrote that points at a user must go before the company cascade reaches
       * that user. Scorecards and comments are written by the tests below.
       */
      const scope = { application: { job: { companyId } } };
      await owner.scorecard.deleteMany({ where: scope });
      await owner.comment.deleteMany({ where: scope });
      await owner.applicationTag.deleteMany({ where: scope });
      await owner.interview.deleteMany({ where: scope });
      await owner.jobAssignment.deleteMany({ where: { job: { companyId } } });
      await owner.stageHistory.deleteMany({ where: scope });
      await owner.auditLog.deleteMany({ where: { companyId } });
      await owner.company.deleteMany({ where: { id: companyId } });
      await owner.candidate.deleteMany({ where: { email: `hma-cand.${suffix}@test.local` } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  /*
   * Each refusal names the UI decision it justifies. A Hiring Manager typing
   * the URL by hand reaches the same wall the hidden control would have.
   */
  describe('refused — every one of these is a control the HM console omits', () => {
    it('GET /applications/:id — 403 (why HM-03 exists instead of RC-06)', async () => {
      await http().get(`/applications/${applicationId}`).set(auth(hmToken)).expect(403);
    });

    it('GET /analytics/funnel — 403 (why there is no HM dashboard or Overview tab)', async () => {
      await http().get('/analytics/funnel').set(auth(hmToken)).expect(403);
    });

    it('POST /jobs — 403 (why "Create job" is hidden)', async () => {
      await http().post('/jobs').set(auth(hmToken)).send({ title: 'Nope' }).expect(403);
    });

    it('PUT /jobs/:id/ranking-weights — 403 (why the weights tab is hidden)', async () => {
      await http()
        .put(`/jobs/${assignedJob}/ranking-weights`)
        .set(auth(hmToken))
        .send({ weights: {} })
        .expect(403);
    });

    it('PATCH /applications/:id/score — 403 (why ScorePanel is readOnly)', async () => {
      await http()
        .patch(`/applications/${applicationId}/score`)
        .set(auth(hmToken))
        .send({ compositeScore: 0.9, reason: 'no' })
        .expect(403);
    });

    it('PATCH /applications/:id/stage — 403 (why no stage control)', async () => {
      await http()
        .patch(`/applications/${applicationId}/stage`)
        .set(auth(hmToken))
        .send({ toStage: 'Interview' })
        .expect(403);
    });

    it('POST /interviews — 403 (why InterviewPanel is readOnly, D26)', async () => {
      await http()
        .post('/interviews')
        .set(auth(hmToken))
        .send({ applicationId, scheduledAt: new Date().toISOString(), timezone: 'UTC' })
        .expect(403);
    });

    it('GET /interviewers — 403 (the picker is a scheduling tool)', async () => {
      await http().get('/interviewers').set(auth(hmToken)).expect(403);
    });

    it('POST /jobs/:id/assignments — 403 (an HM cannot widen their own reach)', async () => {
      await http()
        .post(`/jobs/${assignedJob}/assignments`)
        .set(auth(hmToken))
        .send({ userId: hm })
        .expect(403);
    });

    it('an UNASSIGNED job is 404, not 403 (BR-06)', async () => {
      await http().get(`/jobs/${unassignedJob}`).set(auth(hmToken)).expect(404);
      await http().get(`/jobs/${unassignedJob}/candidates`).set(auth(hmToken)).expect(404);
    });
  });

  /* Each allowance is a panel the HM console actually renders. */
  describe('allowed — every one of these is a panel the HM console renders', () => {
    it('GET /jobs lists ONLY assigned jobs', async () => {
      const response = await http().get('/jobs').set(auth(hmToken)).expect(200);
      const ids = response.body.data.map((j: { id: string }) => j.id);

      expect(ids).toContain(assignedJob);
      expect(ids).not.toContain(unassignedJob);
    });

    it('GET /jobs/:id — the assigned job', async () => {
      await http().get(`/jobs/${assignedJob}`).set(auth(hmToken)).expect(200);
    });

    it('GET /jobs/:id/candidates — with the AI score attached', async () => {
      const response = await http()
        .get(`/jobs/${assignedJob}/candidates`)
        .set(auth(hmToken))
        .expect(200);

      const row = response.body.data.find(
        (r: { applicationId: string }) => r.applicationId === applicationId,
      );
      expect(row).toBeDefined();
      // `score` may be null (no scorer ran), but the FIELD must be served —
      // it is the whole basis of HM-03's assessment panel.
      expect(row).toHaveProperty('score');
      expect(row.candidate).toHaveProperty('fullName');
    });

    it('GET /me/reviews — the HM landing screen', async () => {
      await http().get('/me/reviews').set(auth(hmToken)).expect(200);
    });

    it('GET scorecards, comments, tags and interviews on an assigned application', async () => {
      await http().get(`/applications/${applicationId}/scorecards`).set(auth(hmToken)).expect(200);
      await http().get(`/applications/${applicationId}/comments`).set(auth(hmToken)).expect(200);
      await http().get(`/applications/${applicationId}/tags`).set(auth(hmToken)).expect(200);
      await http().get(`/applications/${applicationId}/interviews`).set(auth(hmToken)).expect(200);
    });

    it('POST a scorecard — the reviewer’s actual job', async () => {
      await http()
        .post(`/applications/${applicationId}/scorecards`)
        .set(auth(hmToken))
        .send({ rating: 4, feedback: 'Strong on the fundamentals.' })
        .expect(201);
    });

    it('POST a comment', async () => {
      await http()
        .post(`/applications/${applicationId}/comments`)
        .set(auth(hmToken))
        .send({ body: 'Agreed — worth an onsite.' })
        .expect(201);
    });
  });
});
