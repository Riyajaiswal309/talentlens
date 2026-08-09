import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditActorType, JobStatus, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditModule } from './audit.module';
import { isKnownAction } from './audit-actions';
import { EXPORT_COLUMNS } from './audit-export.service';
import { MAX_RANGE_DAYS } from './dto/query-audit.dto';
import { AdminModule } from '../admin/admin.module';
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
import { PipelineModule } from '../pipeline/pipeline.module';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * M2.10 AuditModule — FR8.3, NFR8, NFR11 (Handoff §B rows 25–27, Gap 4).
 *
 * The DoD names one acceptance test for this milestone: "generate activity →
 * export → reconcile against source records". That reconciliation is the last
 * describe block, and it compares the exported file against the database row
 * by row rather than asserting a row count.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('AuditModule (FR8.3, NFR8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let jobs: JobsService;
  let applications: ApplicationsService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);

  let companyA = '';
  let companyB = '';
  let adminA = '';
  let recruiterA = '';
  let adminB = '';
  let jobA = '';
  let otherJobA = '';
  let jobB = '';
  let applicationA = '';
  let modelVersionId = '';
  let scoreId = '';

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
  const browse = (token: string, qs = '') =>
    request(app.getHttpServer()).get(`/audit-logs${qs}`).set(auth(token));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        AuthModule,
        JobsModule,
        ApplicationsModule,
        PipelineModule,
        AdminModule,
        AuditModule,
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

    const a = await prisma.company.create({ data: { name: `AudA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `AudB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
      });
      return user.id;
    }

    adminA = await makeUser(companyA, UserRole.ADMIN, 'aud-adm-a');
    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'aud-rec-a');
    adminB = await makeUser(companyB, UserRole.ADMIN, 'aud-adm-b');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `aud-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: adminB,
      email: `aud-adm-b.${suffix}@test.local`,
      role: UserRole.ADMIN,
      companyId: companyB,
    };

    const created = await jobs.create(recA, { title: `Aud job ${suffix}` });
    await jobs.update(recA, created.id, { status: JobStatus.PUBLISHED });
    jobA = created.id;

    const other = await jobs.create(recA, { title: `Aud other ${suffix}` });
    await jobs.update(recA, other.id, { status: JobStatus.PUBLISHED });
    otherJobA = other.id;

    const inB = await jobs.create(recB, { title: `Aud jobB ${suffix}` });
    await jobs.update(recB, inB.id, { status: JobStatus.PUBLISHED });
    jobB = inB.id;

    /*
     * jobs.create() above went through the service, which is not audited.
     * An HTTP edit gives the job an audit entry of its own, so the wider
     * jobId filter has a job-scoped row to find.
     */
    await request(app.getHttpServer())
      .patch(`/jobs/${jobA}`)
      .set(auth(await tokenFor(recruiterA)))
      .send({ department: 'Engineering' })
      .expect(200);

    // ---- generate activity, through the real HTTP pipeline so it is audited
    const submitted = await applications.submit(
      { jobId: jobA, fullName: 'Aud Candidate', email: `audcand.${suffix}@test.local` },
      pdf(),
      `corr-${randomUUID()}`,
    );
    applicationA = submitted.application.id;

    const recToken = await tokenFor(recruiterA);
    await request(app.getHttpServer())
      .patch(`/applications/${applicationA}/stage`)
      .set(auth(recToken))
      .send({ toStage: 'Screening' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/applications/${applicationA}/stage`)
      .set(auth(recToken))
      .send({ toStage: 'Rejected' })
      .expect(200);

    const model = await owner.aiModelVersion.findFirstOrThrow();
    modelVersionId = model.id;
    const score = await owner.matchScore.create({
      data: {
        applicationId: applicationA,
        modelVersionId,
        compositeScore: new Prisma.Decimal(0.77),
        rationale: { summary: 'Strong', factors: [] },
        featureVector: { skill_overlap: 0.7 },
      },
    });
    scoreId = score.id;

    // An audit entry that references a match_score, for the modelVersion detail.
    await owner.auditLog.create({
      data: {
        companyId: companyA,
        actorId: recruiterA,
        actorType: AuditActorType.USER,
        action: 'score.overridden',
        resourceType: 'match_score',
        resourceId: scoreId,
        correlationId: `corr-${randomUUID()}`,
        afterState: { overrideReason: 'Interview outweighed it' },
      },
    });
    await owner.matchScore.update({
      where: { id: scoreId },
      data: { overriddenBy: recruiterA, overrideReason: 'Interview outweighed it' },
    });
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
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  // =========================================================================
  // GET /audit-logs
  // =========================================================================
  describe('GET /audit-logs', () => {
    it('returns the tenant’s entries with totalCount and actorEmail', async () => {
      const response = await browse(await tokenFor(adminA), '?limit=100').expect(200);

      expect(response.body.totalCount).toBeGreaterThan(0);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body).toHaveProperty('nextCursor');

      const withActor = response.body.data.find((r: { actorId: string | null }) => r.actorId);
      expect(withActor.actorEmail).toContain('@test.local');
    });

    /** The whole point of adding company_id — cross-tenant reads are refused. */
    it('never returns another tenant’s entries', async () => {
      const response = await browse(await tokenFor(adminA), '?limit=100').expect(200);

      const ids = response.body.data.map((r: { id: string }) => r.id);
      const foreign = await owner.auditLog.findMany({ where: { companyId: companyB } });
      for (const row of foreign) {
        expect(ids).not.toContain(row.id);
      }
    });

    /**
     * Rows written before company_id existed, and unresolvable at backfill,
     * belong to no tenant and must surface for none.
     */
    it('never returns historical unscoped rows', async () => {
      const unscoped = await owner.auditLog.count({ where: { companyId: null } });
      const response = await browse(await tokenFor(adminA), '?limit=100').expect(200);

      expect(unscoped).toBeGreaterThan(0);
      expect(response.body.data.every((r: { id: string }) => Boolean(r.id))).toBe(true);
      const returned = await owner.auditLog.findMany({
        where: { id: { in: response.body.data.map((r: { id: string }) => r.id) } },
        select: { companyId: true },
      });
      expect(returned.every((r) => r.companyId === companyA)).toBe(true);
    });

    it('filters by actionType', async () => {
      const response = await browse(
        await tokenFor(adminA),
        '?actionType=application.stage_changed&limit=100',
      ).expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
      expect(
        response.body.data.every(
          (r: { action: string }) => r.action === 'application.stage_changed',
        ),
      ).toBe(true);
    });

    /**
     * The vocabulary must cover everything the system writes.
     *
     * An emitted action missing from the list is unfilterable: the browser
     * would 400 on a perfectly real event, which is the same failure Gap 4
     * rule 2 exists to prevent, pointing the other way. Phase 3 added two
     * actions and this test is what caught them.
     */
    it('every action production code emits is filterable', () => {
      const emitted = new Set<string>();

      function walk(dir: string): void {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) {
            walk(path);
            continue;
          }
          if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;

          const source = readFileSync(path, 'utf8');
          for (const match of source.matchAll(/action: '([a-z_]+\.[a-z_]+)'/g)) {
            if (match[1]) emitted.add(match[1]);
          }
        }
      }

      walk(join(__dirname, '..', '..'));

      expect(emitted.size).toBeGreaterThan(0);
      const unfilterable = [...emitted].filter((action) => !isKnownAction(action)).sort();
      expect(unfilterable).toEqual([]);
    });

    it('rejects an unknown actionType rather than matching nothing', async () => {
      const response = await browse(await tokenFor(adminA), '?actionType=job.exploded').expect(400);
      expect(response.body.detail).toMatch(/not a known action/i);
    });

    it('filters by date range', async () => {
      const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const response = await browse(
        await tokenFor(adminA),
        `?from=${from}&to=${to}&limit=100`,
      ).expect(200);
      expect(response.body.totalCount).toBeGreaterThan(0);
    });

    it('excludes entries outside the range', async () => {
      const from = new Date('2020-01-01').toISOString();
      const to = new Date('2020-12-31').toISOString();

      const response = await browse(await tokenFor(adminA), `?from=${from}&to=${to}`).expect(200);
      expect(response.body.totalCount).toBe(0);
    });

    it('400s when from is after to', async () => {
      const response = await browse(
        await tokenFor(adminA),
        `?from=${new Date().toISOString()}&to=${new Date(Date.now() - 86400000).toISOString()}`,
      ).expect(400);

      expect(response.body.detail).toMatch(/earlier than or equal/i);
    });

    it(`400s on a span wider than ${MAX_RANGE_DAYS} days (D8)`, async () => {
      const to = new Date();
      const from = new Date(to.getTime() - (MAX_RANGE_DAYS + 2) * 86400000);

      const response = await browse(
        await tokenFor(adminA),
        `?from=${from.toISOString()}&to=${to.toISOString()}`,
      ).expect(400);

      expect(response.body.detail).toMatch(/at most 366 days/i);
    });

    it('400s on a malformed date', async () => {
      await browse(await tokenFor(adminA), '?from=yesterday').expect(400);
    });

    it('400s on a malformed cursor', async () => {
      await browse(await tokenFor(adminA), '?cursor=nonsense').expect(400);
    });

    it('paginates without repeating a row', async () => {
      const token = await tokenFor(adminA);
      const first = await browse(token, '?limit=1').expect(200);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await browse(token, `?limit=1&cursor=${first.body.nextCursor}`).expect(200);
      expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
      // totalCount describes the whole filtered set, not the page.
      expect(second.body.totalCount).toBe(first.body.totalCount);
    });

    // ---- the approved wider jobId meaning --------------------------------

    it('jobId includes entries about the job itself', async () => {
      const response = await browse(await tokenFor(adminA), `?jobId=${jobA}&limit=100`).expect(200);

      expect(response.body.data.some((r: { resourceId: string }) => r.resourceId === jobA)).toBe(
        true,
      );
    });

    it('jobId includes its applications', async () => {
      const response = await browse(await tokenFor(adminA), `?jobId=${jobA}&limit=100`).expect(200);

      expect(
        response.body.data.some((r: { resourceId: string }) => r.resourceId === applicationA),
      ).toBe(true);
    });

    it('jobId includes match scores on those applications', async () => {
      const response = await browse(await tokenFor(adminA), `?jobId=${jobA}&limit=100`).expect(200);

      expect(response.body.data.some((r: { resourceId: string }) => r.resourceId === scoreId)).toBe(
        true,
      );
    });

    it('jobId excludes another job in the same tenant', async () => {
      const response = await browse(await tokenFor(adminA), `?jobId=${jobA}&limit=100`).expect(200);

      expect(
        response.body.data.some((r: { resourceId: string }) => r.resourceId === otherJobA),
      ).toBe(false);
    });

    it('404s a jobId in another tenant rather than filtering to empty', async () => {
      await browse(await tokenFor(adminA), `?jobId=${jobB}`).expect(404);
    });

    // ---- authorisation ----------------------------------------------------

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/audit-logs').expect(401);
    });

    it('refuses a Recruiter (§24.2)', async () => {
      await browse(await tokenFor(recruiterA)).expect(403);
    });
  });

  // =========================================================================
  // GET /audit-logs/:id
  // =========================================================================
  describe('GET /audit-logs/:id', () => {
    it('returns before/after state and the correlation id', async () => {
      const row = await owner.auditLog.findFirstOrThrow({
        where: { companyId: companyA, action: 'application.stage_changed' },
      });

      const response = await request(app.getHttpServer())
        .get(`/audit-logs/${row.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.body).toMatchObject({ id: row.id, action: 'application.stage_changed' });
      expect(response.body.beforeState).toBeTruthy();
      expect(response.body.afterState).toBeTruthy();
      expect(response.body.correlationId).toBeTruthy();
    });

    /** Gap 4 — §9.3 step 4 reconciles scores against the model version. */
    it('exposes modelVersion where the entry references a match_score', async () => {
      const row = await owner.auditLog.findFirstOrThrow({
        where: { companyId: companyA, resourceType: 'match_score' },
      });

      const response = await request(app.getHttpServer())
        .get(`/audit-logs/${row.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.body.modelVersion).toMatch(/@/);
      expect(response.body.overrideReason).toBe('Interview outweighed it');
    });

    it('omits modelVersion for entries that are not about a score', async () => {
      const row = await owner.auditLog.findFirstOrThrow({
        where: { companyId: companyA, resourceType: 'application' },
      });

      const response = await request(app.getHttpServer())
        .get(`/audit-logs/${row.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.body.modelVersion).toBeNull();
    });

    it('404s an entry in another tenant', async () => {
      const foreign = await owner.auditLog.create({
        data: {
          companyId: companyB,
          actorId: adminB,
          actorType: AuditActorType.USER,
          action: 'job.created',
          resourceType: 'job',
          resourceId: jobB,
          correlationId: `corr-${randomUUID()}`,
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/audit-logs/${foreign.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(404);

      const missing = await request(app.getHttpServer())
        .get(`/audit-logs/${randomUUID()}`)
        .set(auth(await tokenFor(adminA)))
        .expect(404);

      expect(response.body.detail).toBe(missing.body.detail);
    });
  });

  // =========================================================================
  // Append-only at the API surface
  // =========================================================================
  describe('no write verbs (Gap 4 rule 3)', () => {
    it('405s PATCH, DELETE, POST and PUT', async () => {
      const token = await tokenFor(adminA);
      const row = await owner.auditLog.findFirstOrThrow({ where: { companyId: companyA } });

      await request(app.getHttpServer())
        .patch(`/audit-logs/${row.id}`)
        .set(auth(token))
        .send({ action: 'tampered' })
        .expect(405);
      await request(app.getHttpServer())
        .delete(`/audit-logs/${row.id}`)
        .set(auth(token))
        .expect(405);
      await request(app.getHttpServer()).post('/audit-logs').set(auth(token)).send({}).expect(405);
      await request(app.getHttpServer())
        .put(`/audit-logs/${row.id}`)
        .set(auth(token))
        .send({})
        .expect(405);
    });

    it('the entry is untouched afterwards', async () => {
      const row = await owner.auditLog.findFirstOrThrow({ where: { companyId: companyA } });

      await request(app.getHttpServer())
        .patch(`/audit-logs/${row.id}`)
        .set(auth(await tokenFor(adminA)))
        .send({ action: 'tampered' })
        .expect(405);

      const after = await owner.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.action).toBe(row.action);
    });
  });

  // =========================================================================
  // GET /audit-logs/export
  // =========================================================================
  describe('GET /audit-logs/export', () => {
    it('defaults to JSON', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit-logs/export')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-disposition']).toMatch(
        /attachment; filename="audit-.*\.json"/,
      );
      expect(Array.isArray(JSON.parse(response.text))).toBe(true);
    });

    it('produces CSV with the documented header', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit-logs/export?format=csv')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.text.split('\n')[0]).toBe(EXPORT_COLUMNS.join(','));
    });

    it('rejects an unknown format', async () => {
      await request(app.getHttpServer())
        .get('/audit-logs/export?format=xlsx')
        .set(auth(await tokenFor(adminA)))
        .expect(400);
    });

    it('honours the same filters as the browser', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit-logs/export?actionType=application.stage_changed')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const rows = JSON.parse(response.text) as { action: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.action === 'application.stage_changed')).toBe(true);
    });

    it('never exports another tenant’s rows', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit-logs/export')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const exportedIds = (JSON.parse(response.text) as { id: string }[]).map((r) => r.id);
      const foreign = await owner.auditLog.findMany({ where: { companyId: companyB } });
      for (const row of foreign) {
        expect(exportedIds).not.toContain(row.id);
      }
    });

    it('writes audit.exported', async () => {
      const before = await owner.auditLog.count({
        where: { companyId: companyA, action: 'audit.exported' },
      });

      await request(app.getHttpServer())
        .get('/audit-logs/export')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const after = await owner.auditLog.count({
        where: { companyId: companyA, action: 'audit.exported' },
      });
      expect(after).toBe(before + 1);
    });

    /** An export of exports would be bookkeeping about bookkeeping. */
    it('an export never contains audit.exported entries', async () => {
      const token = await tokenFor(adminA);
      await request(app.getHttpServer()).get('/audit-logs/export').set(auth(token)).expect(200);
      await request(app.getHttpServer()).get('/audit-logs/export').set(auth(token)).expect(200);

      const response = await request(app.getHttpServer())
        .get('/audit-logs/export')
        .set(auth(token))
        .expect(200);

      const rows = JSON.parse(response.text) as { action: string }[];
      expect(rows.some((r) => r.action === 'audit.exported')).toBe(false);
    });

    it('refuses a Recruiter', async () => {
      await request(app.getHttpServer())
        .get('/audit-logs/export')
        .set(auth(await tokenFor(recruiterA)))
        .expect(403);
    });

    it('enforces the 366-day cap', async () => {
      const to = new Date();
      const from = new Date(to.getTime() - (MAX_RANGE_DAYS + 2) * 86400000);

      await request(app.getHttpServer())
        .get(`/audit-logs/export?from=${from.toISOString()}&to=${to.toISOString()}`)
        .set(auth(await tokenFor(adminA)))
        .expect(400);
    });
  });

  // =========================================================================
  // DoD — generate → export → reconcile (PRD §30.1)
  // =========================================================================
  describe('export reconciliation (PRD §30.1)', () => {
    it('every exported row matches its source record exactly', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit-logs/export')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const exported = JSON.parse(response.text) as Record<string, string | null>[];

      // Source of truth: the same filter the export used.
      const source = await owner.auditLog.findMany({
        where: { companyId: companyA, action: { not: 'audit.exported' } },
        include: { actor: { select: { email: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      expect(exported).toHaveLength(source.length);

      for (const [index, row] of source.entries()) {
        const line = exported[index];
        expect(line?.id).toBe(row.id);
        expect(line?.action).toBe(row.action);
        expect(line?.resourceId).toBe(row.resourceId);
        expect(line?.correlationId).toBe(row.correlationId);
        expect(line?.actorId).toBe(row.actorId ?? null);
        expect(line?.actorEmail).toBe(row.actor?.email ?? null);
        expect(line?.createdAt).toBe(row.createdAt.toISOString());
      }
    });

    it('CSV reconciles to the same rows as JSON', async () => {
      const token = await tokenFor(adminA);

      const json = JSON.parse(
        (await request(app.getHttpServer()).get('/audit-logs/export').set(auth(token)).expect(200))
          .text,
      ) as { id: string }[];

      const csv = (
        await request(app.getHttpServer())
          .get('/audit-logs/export?format=csv')
          .set(auth(token))
          .expect(200)
      ).text
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => line.split(',')[0]);

      expect(csv).toEqual(json.map((r) => r.id));
    });

    it('newly generated activity appears in the next export', async () => {
      const token = await tokenFor(adminA);

      const before = (
        JSON.parse(
          (
            await request(app.getHttpServer())
              .get('/audit-logs/export')
              .set(auth(token))
              .expect(200)
          ).text,
        ) as { id: string }[]
      ).length;

      // Generate one more auditable event.
      await request(app.getHttpServer())
        .patch(`/applications/${applicationA}/stage`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ toStage: 'Interview' })
        .expect(200);

      const after = JSON.parse(
        (await request(app.getHttpServer()).get('/audit-logs/export').set(auth(token)).expect(200))
          .text,
      ) as { action: string }[];

      expect(after.length).toBeGreaterThan(before);
      expect(after.some((r) => r.action === 'application.stage_changed')).toBe(true);
    });
  });
});
