import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PipelineModule } from './pipeline.module';
import { MAX_BULK_APPLICATIONS } from './dto/bulk-change-stage.dto';
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
 * PATCH /v1/applications/bulk/stage — FR5.2, Phase 1 RC-10.
 *
 * The properties that matter here are per-item: partial failure, one audit
 * record per moved candidate, and the guarantee that a failing item neither
 * aborts the batch nor rolls back its neighbours. All of that only exists
 * end to end, so the harness runs the real guard chain and the real
 * AuditInterceptor.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Bulk stage change (FR5.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;
  let applications: ApplicationsService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;
  const userIds: string[] = [];

  let companyA = '';
  let companyB = '';
  let recruiterA = '';
  let hmA = '';
  let recruiterB = '';
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

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function newApplication(tag: string, job = jobA): Promise<string> {
    const result = await applications.submit(
      { jobId: job, fullName: `Bulk ${tag}`, email: `${tag}.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
    return result.application.id;
  }

  function bulk(applicationIds: string[], toStage: string, token: string) {
    return request(app.getHttpServer())
      .patch('/applications/bulk/stage')
      .set(auth(token))
      .send({ applicationIds, toStage });
  }

  const stageOf = async (id: string) =>
    (await prisma.application.findUnique({ where: { id } }))?.currentStage;

  const auditsFor = async (id: string) =>
    (
      await prisma.auditLog.findMany({
        where: { resourceId: id, resourceType: 'application' },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.action);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        NotificationsModule,
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
      data: { name: `BulkA ${suffix}`, dataRegion: 'test' },
    });
    const b = await prisma.company.create({
      data: { name: `BulkB ${suffix}`, dataRegion: 'test' },
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

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'bulk-rec-a');
    hmA = await makeUser(companyA, UserRole.HIRING_MANAGER, 'bulk-hm-a');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'bulk-rec-b');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `bulk-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: recruiterB,
      email: `bulk-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    const created = await jobs.create(recA, { title: `Bulk job ${suffix}` });
    await jobs.update(recA, created.id, { status: JobStatus.PUBLISHED });
    jobA = created.id;

    const createdB = await jobs.create(recB, { title: `Bulk jobB ${suffix}` });
    await jobs.update(recB, createdB.id, { status: JobStatus.PUBLISHED });
    jobB = createdB.id;
  });

  /** Owner connection and ordered deletes — see stage-transitions.spec.ts. */
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
  // Happy path
  // =========================================================================
  describe('moving a selection', () => {
    it('moves every candidate in the batch', async () => {
      const ids = [
        await newApplication('h1'),
        await newApplication('h2'),
        await newApplication('h3'),
      ];

      const response = await bulk(ids, 'Screening', await tokenFor(recruiterA)).expect(200);

      expect(response.body.succeeded.sort()).toEqual([...ids].sort());
      expect(response.body.failed).toEqual([]);

      for (const id of ids) {
        await expect(stageOf(id)).resolves.toBe('Screening');
      }
    });

    it('writes one stage_history row per candidate (FR5.4)', async () => {
      const ids = [await newApplication('hist-a'), await newApplication('hist-b')];
      await bulk(ids, 'Interview', await tokenFor(recruiterA)).expect(200);

      for (const id of ids) {
        const history = await prisma.stageHistory.findMany({ where: { applicationId: id } });
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          fromStage: 'Applied',
          toStage: 'Interview',
          changedBy: recruiterA,
        });
      }
    });

    it('accepts a single-item batch', async () => {
      const id = await newApplication('single');

      const response = await bulk([id], 'Offer', await tokenFor(recruiterA)).expect(200);
      expect(response.body.succeeded).toEqual([id]);
    });

    it('deduplicates a repeated id into one move', async () => {
      const id = await newApplication('dupe');

      const response = await bulk([id, id, id], 'Screening', await tokenFor(recruiterA)).expect(
        200,
      );

      expect(response.body.succeeded).toEqual([id]);
      await expect(prisma.stageHistory.count({ where: { applicationId: id } })).resolves.toBe(1);
    });

    it('counts a candidate already in the target stage as succeeded, with no history', async () => {
      const id = await newApplication('already');

      const response = await bulk([id], 'Applied', await tokenFor(recruiterA)).expect(200);

      expect(response.body.succeeded).toEqual([id]);
      await expect(prisma.stageHistory.count({ where: { applicationId: id } })).resolves.toBe(0);
      await expect(auditsFor(id)).resolves.not.toContain('application.stage_changed');
    });
  });

  // =========================================================================
  // Audit — per candidate (Handoff §I)
  // =========================================================================
  describe('audit', () => {
    it('writes one application.stage_changed PER candidate', async () => {
      const ids = [await newApplication('aud-a'), await newApplication('aud-b')];
      await bulk(ids, 'Screening', await tokenFor(recruiterA)).expect(200);

      for (const id of ids) {
        const actions = await auditsFor(id);
        expect(actions.filter((a) => a === 'application.stage_changed')).toHaveLength(1);
      }
    });

    it('a bulk rejection writes application.rejected per candidate too', async () => {
      const ids = [await newApplication('rej-a'), await newApplication('rej-b')];
      await bulk(ids, 'Rejected', await tokenFor(recruiterA)).expect(200);

      for (const id of ids) {
        const actions = await auditsFor(id);
        expect(actions).toContain('application.stage_changed');
        expect(actions).toContain('application.rejected');
      }
    });

    it('a bulk hire writes application.hired per candidate', async () => {
      const id = await newApplication('hire');
      await bulk([id], 'Hired', await tokenFor(recruiterA)).expect(200);

      expect(await auditsFor(id)).toContain('application.hired');
    });

    it('records the actor and one shared correlation id', async () => {
      const ids = [await newApplication('corr-a'), await newApplication('corr-b')];
      await bulk(ids, 'Screening', await tokenFor(recruiterA)).expect(200);

      const rows = await prisma.auditLog.findMany({
        where: { resourceId: { in: ids }, action: 'application.stage_changed' },
      });

      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.actorId === recruiterA)).toBe(true);
      // One request, so one correlation id across both candidates.
      expect(new Set(rows.map((r) => r.correlationId)).size).toBe(1);
    });

    it('writes NO audit record for a candidate that failed', async () => {
      const good = await newApplication('mix-good');
      const missing = randomUUID();

      await bulk([good, missing], 'Screening', await tokenFor(recruiterA)).expect(200);

      const rows = await prisma.auditLog.findMany({ where: { resourceId: missing } });
      expect(rows).toHaveLength(0);
    });
  });

  // =========================================================================
  // Partial failure (RC-10)
  // =========================================================================
  describe('partial failure', () => {
    it('moves the valid ones and reports the rest', async () => {
      const good1 = await newApplication('p1');
      const good2 = await newApplication('p2');
      const missing = randomUUID();

      const response = await bulk(
        [good1, missing, good2],
        'Screening',
        await tokenFor(recruiterA),
      ).expect(200);

      expect(response.body.succeeded.sort()).toEqual([good1, good2].sort());
      expect(response.body.failed).toEqual([{ id: missing, reason: 'Not found' }]);

      await expect(stageOf(good1)).resolves.toBe('Screening');
      await expect(stageOf(good2)).resolves.toBe('Screening');
    });

    it('a failure does not roll back the neighbours already moved', async () => {
      const first = await newApplication('order1');
      const missing = randomUUID();
      const last = await newApplication('order2');

      // The failure sits in the middle: the one before must stay moved and
      // the one after must still be attempted.
      await bulk([first, missing, last], 'Interview', await tokenFor(recruiterA)).expect(200);

      await expect(stageOf(first)).resolves.toBe('Interview');
      await expect(stageOf(last)).resolves.toBe('Interview');
    });

    it('reports a stage that does not exist on that candidate job', async () => {
      const id = await newApplication('badstage');

      const response = await bulk([id], 'Shortlisted', await tokenFor(recruiterA)).expect(200);

      expect(response.body.succeeded).toEqual([]);
      expect(response.body.failed[0].id).toBe(id);
      expect(response.body.failed[0].reason).toMatch(/not a stage on this job/i);
      await expect(stageOf(id)).resolves.toBe('Applied');
    });

    it('still returns 200 when every item fails', async () => {
      const response = await bulk(
        [randomUUID(), randomUUID()],
        'Screening',
        await tokenFor(recruiterA),
      ).expect(200);

      expect(response.body.succeeded).toEqual([]);
      expect(response.body.failed).toHaveLength(2);
    });

    /**
     * BR-06 — a foreign candidate must be indistinguishable from a missing
     * one, in a bulk response as much as in a single one. Otherwise the
     * endpoint becomes an oracle for ids in other tenants.
     */
    it('BR-06: gives a foreign candidate the SAME reason as a missing one', async () => {
      const inOtherTenant = await newApplication('foreign', jobB);
      const missing = randomUUID();

      const response = await bulk(
        [inOtherTenant, missing],
        'Screening',
        await tokenFor(recruiterA),
      ).expect(200);

      const reasons = response.body.failed.map((f: { reason: string }) => f.reason);
      expect(new Set(reasons).size).toBe(1);
      expect(reasons[0]).toBe('Not found');
      await expect(stageOf(inOtherTenant)).resolves.toBe('Applied');
    });
  });

  // =========================================================================
  // Validation
  // =========================================================================
  describe('validation', () => {
    it(`rejects more than ${MAX_BULK_APPLICATIONS} ids`, async () => {
      const tooMany = Array.from({ length: MAX_BULK_APPLICATIONS + 1 }, () => randomUUID());

      const response = await bulk(tooMany, 'Screening', await tokenFor(recruiterA)).expect(400);
      expect(response.body.detail).toMatch(/at most 100 candidates/i);
    });

    it(`accepts exactly ${MAX_BULK_APPLICATIONS} ids`, async () => {
      const atLimit = Array.from({ length: MAX_BULK_APPLICATIONS }, () => randomUUID());

      // All unknown, so all fail — the point is that the DTO lets them through.
      const response = await bulk(atLimit, 'Screening', await tokenFor(recruiterA)).expect(200);
      expect(response.body.failed).toHaveLength(MAX_BULK_APPLICATIONS);
    });

    it('rejects an empty selection', async () => {
      const response = await bulk([], 'Screening', await tokenFor(recruiterA)).expect(400);
      expect(response.body.detail).toMatch(/at least one candidate/i);
    });

    it('rejects a non-uuid in the list', async () => {
      const response = await bulk(
        [randomUUID(), 'not-a-uuid'],
        'Screening',
        await tokenFor(recruiterA),
      ).expect(400);

      expect(response.body.detail).toMatch(/valid identifiers/i);
    });

    it('rejects a missing toStage', async () => {
      await request(app.getHttpServer())
        .patch('/applications/bulk/stage')
        .set(auth(await tokenFor(recruiterA)))
        .send({ applicationIds: [randomUUID()] })
        .expect(400);
    });

    it('rejects an unexpected field', async () => {
      await request(app.getHttpServer())
        .patch('/applications/bulk/stage')
        .set(auth(await tokenFor(recruiterA)))
        .send({ applicationIds: [randomUUID()], toStage: 'Screening', changedBy: recruiterA })
        .expect(400);
    });

    /** `bulk` must not be swallowed by the `:id/stage` route as a malformed uuid. */
    it('routes to the bulk handler, not to :id/stage', async () => {
      const response = await bulk([randomUUID()], 'Screening', await tokenFor(recruiterA)).expect(
        200,
      );

      // A 400 "malformed uuid" here would mean :id captured 'bulk'.
      expect(response.body).toHaveProperty('succeeded');
      expect(response.body).toHaveProperty('failed');
    });
  });

  // =========================================================================
  // Authorisation
  // =========================================================================
  describe('authorisation', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .patch('/applications/bulk/stage')
        .send({ applicationIds: [randomUUID()], toStage: 'Screening' })
        .expect(401);
    });

    it('§24.2: refuses a Hiring Manager', async () => {
      const id = await newApplication('authz-hm');
      await bulk([id], 'Screening', await tokenFor(hmA)).expect(403);
      await expect(stageOf(id)).resolves.toBe('Applied');
    });

    it('a Recruiter from another tenant moves nothing', async () => {
      const id = await newApplication('authz-cross');

      const response = await bulk([id], 'Hired', await tokenFor(recruiterB)).expect(200);

      expect(response.body.succeeded).toEqual([]);
      expect(response.body.failed).toEqual([{ id, reason: 'Not found' }]);
      await expect(stageOf(id)).resolves.toBe('Applied');
    });
  });
});
