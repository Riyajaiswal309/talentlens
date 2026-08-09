import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PipelineModule } from './pipeline.module';
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
 * PATCH /v1/applications/:id/stage — FR5.1, FR5.4, BR-01.
 *
 * Run over HTTP with the real guard chain AND the real AuditInterceptor,
 * because three of the properties under test only exist end to end: the role
 * matrix (§24.2 excludes Hiring Managers), 404-not-403 tenancy (BR-06), and
 * the two audit rows a terminal decision must produce (Handoff §I).
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Stage transitions (FR5.4, BR-01)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;
  let applications: ApplicationsService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;

  let companyA = '';
  let companyB = '';
  let recruiterA = '';
  let adminA = '';
  let hmA = '';
  let recruiterB = '';
  let candidateUser = '';
  /** Every user this run created, so cleanup can clear their audit rows. */
  const userIds: string[] = [];
  let jobA = '';
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

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  /** A fresh application on jobA, so each test owns its own history. */
  async function newApplication(tag: string, job = jobA): Promise<string> {
    const result = await applications.submit(
      { jobId: job, fullName: `Cand ${tag}`, email: `${tag}.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
    return result.application.id;
  }

  function move(id: string, toStage: string, token: string) {
    return request(app.getHttpServer())
      .patch(`/applications/${id}/stage`)
      .set(auth(token))
      .send({ toStage });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        AuthModule,
        JobsModule,
        ApplicationsModule,
        PipelineModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: RequestContext, res: Response, next: NextFunction) =>
      new CorrelationIdMiddleware().use(req, res, next),
    );

    // main.ts order, guards and interceptors both.
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

    const a = await prisma.company.create({
      data: { name: `PipeA ${suffix}`, dataRegion: 'test' },
    });
    const b = await prisma.company.create({
      data: { name: `PipeB ${suffix}`, dataRegion: 'test' },
    });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local` },
      });
      userIds.push(user.id);
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'pipe-rec-a');
    adminA = await makeUser(companyA, UserRole.ADMIN, 'pipe-admin-a');
    hmA = await makeUser(companyA, UserRole.HIRING_MANAGER, 'pipe-hm-a');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'pipe-rec-b');
    candidateUser = await makeUser(companyA, UserRole.CANDIDATE, 'pipe-cand');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `pipe-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: recruiterB,
      email: `pipe-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    const created = await jobs.create(recA, { title: `Pipe job ${suffix}` });
    await jobs.update(recA, created.id, { status: JobStatus.PUBLISHED });
    jobA = created.id;

    const createdB = await jobs.create(recB, { title: `Pipe jobB ${suffix}` });
    await jobs.update(recB, createdB.id, { status: JobStatus.PUBLISHED });
    jobB = createdB.id;
  });

  /**
   * Cleanup needs the OWNER connection and a deliberate order.
   *
   * This is the first suite whose requests write audit rows with a real
   * actor, and both `audit_logs.actor_id` and `stage_history.changed_by` are
   * ON DELETE RESTRICT against `users` — so deleting the company cascades to
   * its users and is refused while those rows still point at them. The
   * restricted application role also holds INSERT and SELECT only on
   * audit_logs (PRD §17.3), which is the whole point of that grant, so the
   * rows can only be removed as the owner.
   *
   * Wrapped in try/finally because an exception here previously left the Nest
   * app open and hung the runner instead of reporting the failure.
   */
  afterAll(async () => {
    const owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);

    try {
      await owner.$connect();

      const applicationIds = (
        await owner.application.findMany({
          where: { job: { companyId: { in: [companyA, companyB] } } },
          select: { id: true },
        })
      ).map((row) => row.id);

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
  // Moving
  // =========================================================================
  describe('moving an application', () => {
    it('moves it to another stage of its own job', async () => {
      const id = await newApplication('move1');

      const response = await move(id, 'Screening', await tokenFor(recruiterA)).expect(200);

      expect(response.body).toMatchObject({
        id,
        currentStage: 'Screening',
        previousStage: 'Applied',
        isTerminal: false,
      });
    });

    it('persists the new stage on the application row', async () => {
      const id = await newApplication('move2');
      await move(id, 'Interview', await tokenFor(recruiterA)).expect(200);

      const row = await prisma.application.findUnique({ where: { id } });
      expect(row?.currentStage).toBe('Interview');
    });

    it('lets an Admin move it too', async () => {
      const id = await newApplication('move3');
      await move(id, 'Screening', await tokenFor(adminA)).expect(200);
    });

    /** Approved: any stage on the pipeline is a legal target. */
    it('allows a BACKWARD move', async () => {
      const id = await newApplication('back');
      const token = await tokenFor(recruiterA);

      await move(id, 'Interview', token).expect(200);
      const response = await move(id, 'Applied', token).expect(200);

      expect(response.body).toMatchObject({ currentStage: 'Applied', previousStage: 'Interview' });
    });

    it('allows SKIPPING stages', async () => {
      const id = await newApplication('skip');

      const response = await move(id, 'Offer', await tokenFor(recruiterA)).expect(200);
      expect(response.body).toMatchObject({ currentStage: 'Offer', previousStage: 'Applied' });
    });

    it('allows LEAVING a terminal stage', async () => {
      const id = await newApplication('leave');
      const token = await tokenFor(recruiterA);

      await move(id, 'Rejected', token).expect(200);
      const response = await move(id, 'Screening', token).expect(200);

      expect(response.body).toMatchObject({ currentStage: 'Screening', previousStage: 'Rejected' });
    });
  });

  // =========================================================================
  // FR5.4 — history
  // =========================================================================
  describe('FR5.4 stage_history', () => {
    it('records the transition with actor and timestamp', async () => {
      const id = await newApplication('hist1');
      await move(id, 'Screening', await tokenFor(recruiterA)).expect(200);

      const history = await prisma.stageHistory.findMany({ where: { applicationId: id } });

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStage: 'Applied',
        toStage: 'Screening',
        changedBy: recruiterA,
      });
      expect(history[0]?.changedAt).toBeInstanceOf(Date);
    });

    it('appends one row per transition, in order', async () => {
      const id = await newApplication('hist2');
      const token = await tokenFor(recruiterA);

      await move(id, 'Screening', token).expect(200);
      await move(id, 'Interview', token).expect(200);
      await move(id, 'Offer', token).expect(200);

      const history = await prisma.stageHistory.findMany({
        where: { applicationId: id },
        orderBy: { changedAt: 'asc' },
      });

      expect(history.map((h) => `${h.fromStage}->${h.toStage}`)).toEqual([
        'Applied->Screening',
        'Screening->Interview',
        'Interview->Offer',
      ]);
    });

    /**
     * BR-01 — "No candidate may be automatically rejected by the AI system
     * without human review and confirmation." Enforced structurally:
     * changed_by is NOT NULL and comes from the authenticated principal, so
     * no rejection can exist without a human on record.
     */
    it('BR-01: a rejection always carries the human who made it', async () => {
      const id = await newApplication('br01');
      await move(id, 'Rejected', await tokenFor(adminA)).expect(200);

      const history = await prisma.stageHistory.findFirst({
        where: { applicationId: id, toStage: 'Rejected' },
      });

      expect(history?.changedBy).toBe(adminA);
    });

    it('writes no history row when the move is rejected', async () => {
      const id = await newApplication('nohist');

      await move(id, 'Nonexistent Stage', await tokenFor(recruiterA)).expect(400);

      await expect(prisma.stageHistory.count({ where: { applicationId: id } })).resolves.toBe(0);
    });
  });

  // =========================================================================
  // Audit (Handoff §I)
  // =========================================================================
  describe('audit trail', () => {
    async function auditsFor(applicationId: string) {
      return prisma.auditLog.findMany({
        where: { resourceId: applicationId, resourceType: 'application' },
        orderBy: { createdAt: 'asc' },
      });
    }

    it('writes application.stage_changed with before and after', async () => {
      const id = await newApplication('aud1');
      await move(id, 'Screening', await tokenFor(recruiterA)).expect(200);

      const rows = (await auditsFor(id)).filter((r) => r.action === 'application.stage_changed');

      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorId).toBe(recruiterA);
      expect(rows[0]?.actorType).toBe('USER');
      expect(rows[0]?.beforeState).toMatchObject({ currentStage: 'Applied' });
      expect(rows[0]?.afterState).toMatchObject({ currentStage: 'Screening' });
    });

    /** Handoff §I lists the terminal decision as its own event. */
    it('a move to Hired writes stage_changed AND application.hired', async () => {
      const id = await newApplication('aud-hired');
      await move(id, 'Hired', await tokenFor(recruiterA)).expect(200);

      const actions = (await auditsFor(id)).map((r) => r.action);

      expect(actions).toContain('application.stage_changed');
      expect(actions).toContain('application.hired');
    });

    it('a move to Rejected writes stage_changed AND application.rejected', async () => {
      const id = await newApplication('aud-rej');
      await move(id, 'Rejected', await tokenFor(recruiterA)).expect(200);

      const actions = (await auditsFor(id)).map((r) => r.action);

      expect(actions).toContain('application.stage_changed');
      expect(actions).toContain('application.rejected');
      expect(actions).not.toContain('application.hired');
    });

    it('the transition is recorded BEFORE the terminal decision', async () => {
      const id = await newApplication('aud-order');
      await move(id, 'Hired', await tokenFor(recruiterA)).expect(200);

      const actions = (await auditsFor(id))
        .map((r) => r.action)
        .filter((a) => a !== 'application.submitted');

      expect(actions).toEqual(['application.stage_changed', 'application.hired']);
    });

    it('a NON-terminal move writes only stage_changed', async () => {
      const id = await newApplication('aud-plain');
      await move(id, 'Interview', await tokenFor(recruiterA)).expect(200);

      const actions = (await auditsFor(id)).map((r) => r.action);

      expect(actions.filter((a) => a === 'application.stage_changed')).toHaveLength(1);
      expect(actions).not.toContain('application.hired');
      expect(actions).not.toContain('application.rejected');
    });

    it('every record carries a correlation id (NFR11)', async () => {
      const id = await newApplication('aud-corr');
      await move(id, 'Hired', await tokenFor(recruiterA)).expect(200);

      const rows = (await auditsFor(id)).filter((r) => r.action !== 'application.submitted');
      expect(rows.every((r) => Boolean(r.correlationId))).toBe(true);
      // Both rows come from ONE request, so they share one id.
      expect(new Set(rows.map((r) => r.correlationId)).size).toBe(1);
    });
  });

  // =========================================================================
  // No-op
  // =========================================================================
  describe('moving to the stage it is already in', () => {
    it('succeeds without changing anything', async () => {
      const id = await newApplication('noop');

      const response = await move(id, 'Applied', await tokenFor(recruiterA)).expect(200);
      expect(response.body.currentStage).toBe('Applied');
    });

    it('writes no history row and no audit record', async () => {
      const id = await newApplication('noop2');
      await move(id, 'Applied', await tokenFor(recruiterA)).expect(200);

      await expect(prisma.stageHistory.count({ where: { applicationId: id } })).resolves.toBe(0);

      const audits = await prisma.auditLog.findMany({
        where: { resourceId: id, action: 'application.stage_changed' },
      });
      expect(audits).toHaveLength(0);
    });
  });

  // =========================================================================
  // Validation
  // =========================================================================
  describe('validation', () => {
    it('rejects a stage that is not on this job', async () => {
      const id = await newApplication('val1');

      const response = await move(id, 'Shortlisted', await tokenFor(recruiterA)).expect(400);

      expect(response.body.detail).toMatch(/not a stage on this job/i);
      // The message names what IS available, so the caller can correct it.
      expect(response.body.detail).toMatch(/Applied/);
    });

    it('rejects an empty toStage', async () => {
      const id = await newApplication('val2');
      await move(id, '', await tokenFor(recruiterA)).expect(400);
    });

    it('rejects a body with an unexpected field', async () => {
      const id = await newApplication('val3');

      await request(app.getHttpServer())
        .patch(`/applications/${id}/stage`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ toStage: 'Screening', changedBy: adminA })
        .expect(400);
    });

    it('rejects a malformed application id', async () => {
      await request(app.getHttpServer())
        .patch('/applications/not-a-uuid/stage')
        .set(auth(await tokenFor(recruiterA)))
        .send({ toStage: 'Screening' })
        .expect(400);
    });

    it('is case sensitive on the stage name', async () => {
      const id = await newApplication('val4');
      await move(id, 'screening', await tokenFor(recruiterA)).expect(400);
    });
  });

  // =========================================================================
  // Authorisation (PRD §24.2, BR-06)
  // =========================================================================
  describe('authorisation', () => {
    it('requires authentication', async () => {
      const id = await newApplication('auth1');

      await request(app.getHttpServer())
        .patch(`/applications/${id}/stage`)
        .send({ toStage: 'Screening' })
        .expect(401);
    });

    /** PRD §24.2 Table 24.1 — "Move pipeline stage: Hiring Manager —". */
    it('§24.2: refuses a Hiring Manager', async () => {
      const id = await newApplication('auth2');
      await move(id, 'Screening', await tokenFor(hmA)).expect(403);
    });

    it('refuses a Candidate', async () => {
      const id = await newApplication('auth3');
      await move(id, 'Screening', await tokenFor(candidateUser)).expect(403);
    });

    it('BR-06: 404s a Recruiter from another tenant, never 403', async () => {
      const id = await newApplication('auth4');

      const response = await move(id, 'Screening', await tokenFor(recruiterB)).expect(404);
      expect(response.body.status).toBe(404);
    });

    it('a foreign application is indistinguishable from a missing one', async () => {
      const id = await newApplication('auth5');
      const token = await tokenFor(recruiterB);

      const foreign = await move(id, 'Screening', token).expect(404);
      const missing = await move(randomUUID(), 'Screening', token).expect(404);

      expect(foreign.body.detail).toBe(missing.body.detail);
      expect(foreign.body.title).toBe(missing.body.title);
    });

    it('a refused cross-tenant move changes nothing', async () => {
      const id = await newApplication('auth6');
      await move(id, 'Hired', await tokenFor(recruiterB)).expect(404);

      const row = await prisma.application.findUnique({ where: { id } });
      expect(row?.currentStage).toBe('Applied');
      await expect(prisma.stageHistory.count({ where: { applicationId: id } })).resolves.toBe(0);
    });

    /** Stages are per-job, so a name from another tenant's job is still invalid here. */
    it('cannot borrow a stage from another job', async () => {
      const idInB = await newApplication('auth7', jobB);

      await move(idInB, 'Screening', await tokenFor(recruiterA)).expect(404);
    });
  });
});
