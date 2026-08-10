import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ApplicationSource, JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ApplicationsModule } from './applications.module';
import { ApplicationsService } from './applications.service';
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
 * FR7.3 — source of hire: capture and correction.
 *
 * The requirement was unimplementable until the vocabulary and capture point
 * were fixed (A14, B7, C3, D27–D33). These tests pin the parts of that
 * decision that would be silently lost if someone widened the enum, made the
 * field required, or let a candidate see or set it.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Application source of hire (FR7.3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let applications: ApplicationsService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;

  let companyA = '';
  let companyB = '';
  let recruiterA = '';
  let adminA = '';
  let hmA = '';
  let candidateUser = '';
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

  /** Submit over HTTP, so the DTO's allow-list actually runs. */
  const submit = (fields: Record<string, string>) => {
    const req = request(app.getHttpServer()).post('/applications');
    for (const [key, value] of Object.entries(fields)) req.field(key, value);
    return req.attach('resume', Buffer.from('%PDF-1.4\n%%EOF\n'), 'resume.pdf');
  };

  const patchSource = (id: string, body: object, token: string) =>
    request(app.getHttpServer()).patch(`/applications/${id}/source`).set(auth(token)).send(body);

  /** Seed an application directly, bypassing HTTP, with a chosen source. */
  async function seed(jobId: string, tag: string, source?: ApplicationSource): Promise<string> {
    const { application } = await applications.submit(
      { jobId, fullName: `Src ${tag}`, email: `src${tag}.${suffix}@test.local`, source },
      pdf(),
      CORRELATION,
    );
    return application.id;
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
    applications = moduleRef.get(ApplicationsService);
    tokens = moduleRef.get(TokenService);
    const jobs = moduleRef.get(JobsService);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `SrcA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `SrcB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
      });
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'sr-rec-a');
    adminA = await makeUser(companyA, UserRole.ADMIN, 'sr-adm-a');
    hmA = await makeUser(companyA, UserRole.HIRING_MANAGER, 'sr-hm-a');
    candidateUser = await makeUser(companyA, UserRole.CANDIDATE, 'sr-cand');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'sr-rec-b');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `sr-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: recruiterB,
      email: `sr-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    const createdA = await jobs.create(recA, { title: `Src job A ${suffix}` });
    await jobs.update(recA, createdA.id, { status: JobStatus.PUBLISHED });
    jobA = createdA.id;

    const createdB = await jobs.create(recB, { title: `Src job B ${suffix}` });
    await jobs.update(recB, createdB.id, { status: JobStatus.PUBLISHED });
    jobB = createdB.id;
  });

  afterAll(async () => {
    try {
      const companies = [companyA, companyB];
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
      await owner.candidate.deleteMany({ where: { email: { contains: suffix } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  describe('capture at submission', () => {
    it.each(Object.values(ApplicationSource))('accepts the approved value %s', async (value) => {
      const response = await submit({
        jobId: jobA,
        fullName: 'Src Valid',
        email: `srcvalid.${value}.${suffix}@test.local`,
        source: value,
      }).expect(201);

      const stored = await owner.application.findUniqueOrThrow({
        where: { id: response.body.id },
        select: { source: true },
      });
      expect(stored.source).toBe(value);
    });

    it('rejects a value outside the closed allow-list with 400', async () => {
      const response = await submit({
        jobId: jobA,
        fullName: 'Src Invalid',
        email: `srcinvalid.${suffix}@test.local`,
        source: 'agency',
      }).expect(400);

      expect(response.body.detail).toMatch(/source must be one of/i);
    });

    it('rejects a value that differs only in case', async () => {
      await submit({
        jobId: jobA,
        fullName: 'Src Case',
        email: `srccase.${suffix}@test.local`,
        source: 'REFERRAL',
      }).expect(400);
    });

    it('stores NULL when the field is omitted — intake is never blocked (FR2.1)', async () => {
      const response = await submit({
        jobId: jobA,
        fullName: 'Src Omitted',
        email: `srcomitted.${suffix}@test.local`,
      }).expect(201);

      const stored = await owner.application.findUniqueOrThrow({
        where: { id: response.body.id },
        select: { source: true },
      });
      expect(stored.source).toBeNull();
    });

    /** D31 — a retry that only adds a source must not become a 409. */
    it('is excluded from the Idempotency-Key fingerprint', async () => {
      const key = randomUUID();
      const email = `srcidem.${suffix}@test.local`;

      const first = await request(app.getHttpServer())
        .post('/applications')
        .set('Idempotency-Key', key)
        .field('jobId', jobA)
        .field('fullName', 'Src Idem')
        .field('email', email)
        .field('source', ApplicationSource.job_board)
        .attach('resume', Buffer.from('%PDF-1.4\n%%EOF\n'), 'resume.pdf')
        .expect(201);

      // Same key, same identity, DIFFERENT source: a replay, not a conflict.
      const replay = await request(app.getHttpServer())
        .post('/applications')
        .set('Idempotency-Key', key)
        .field('jobId', jobA)
        .field('fullName', 'Src Idem')
        .field('email', email)
        .field('source', ApplicationSource.referral)
        .attach('resume', Buffer.from('%PDF-1.4\n%%EOF\n'), 'resume.pdf')
        .expect(201);

      expect(replay.body.id).toBe(first.body.id);
      const stored = await owner.application.findUniqueOrThrow({
        where: { id: first.body.id },
        select: { source: true },
      });
      // The original stands; the replay did not rewrite it.
      expect(stored.source).toBe(ApplicationSource.job_board);
    });
  });

  describe('correction — PATCH /v1/applications/:id/source', () => {
    it('a Recruiter corrects it', async () => {
      const id = await seed(jobA, 'reccorrect', ApplicationSource.job_board);

      const response = await patchSource(
        id,
        { source: ApplicationSource.referral },
        await tokenFor(recruiterA),
      ).expect(200);

      expect(response.body).toEqual({ id, source: ApplicationSource.referral });
    });

    it('an Administrator corrects it', async () => {
      const id = await seed(jobA, 'admcorrect', ApplicationSource.other);
      await patchSource(
        id,
        { source: ApplicationSource.career_site },
        await tokenFor(adminA),
      ).expect(200);
    });

    it('records a source that was never captured', async () => {
      const id = await seed(jobA, 'wasnull');

      await patchSource(
        id,
        { source: ApplicationSource.referral },
        await tokenFor(recruiterA),
      ).expect(200);

      const stored = await owner.application.findUniqueOrThrow({
        where: { id },
        select: { source: true },
      });
      expect(stored.source).toBe(ApplicationSource.referral);
    });

    it('rejects a value outside the allow-list', async () => {
      const id = await seed(jobA, 'badpatch', ApplicationSource.other);
      await patchSource(id, { source: 'agency' }, await tokenFor(recruiterA)).expect(400);
    });

    it('rejects an omitted source — this endpoint asserts a value', async () => {
      const id = await seed(jobA, 'emptypatch', ApplicationSource.other);
      await patchSource(id, {}, await tokenFor(recruiterA)).expect(400);
    });

    it('rejects an unknown field', async () => {
      const id = await seed(jobA, 'extrapatch', ApplicationSource.other);
      await patchSource(
        id,
        { source: ApplicationSource.referral, note: 'why' },
        await tokenFor(recruiterA),
      ).expect(400);
    });
  });

  describe('RBAC and tenancy', () => {
    it('a Hiring Manager may not correct source (§24.2)', async () => {
      const id = await seed(jobA, 'hmrefuse', ApplicationSource.other);
      await patchSource(id, { source: ApplicationSource.referral }, await tokenFor(hmA)).expect(
        403,
      );
    });

    it('a Candidate may not correct source', async () => {
      const id = await seed(jobA, 'candrefuse', ApplicationSource.other);
      await patchSource(
        id,
        { source: ApplicationSource.referral },
        await tokenFor(candidateUser),
      ).expect(403);
    });

    it('an unauthenticated caller may not correct source', async () => {
      const id = await seed(jobA, 'anonrefuse', ApplicationSource.other);
      await request(app.getHttpServer())
        .patch(`/applications/${id}/source`)
        .send({ source: ApplicationSource.referral })
        .expect(401);
    });

    it("another tenant's application is 404, not 403 (BR-06)", async () => {
      const foreignId = await seed(jobB, 'foreign', ApplicationSource.other);

      await patchSource(
        foreignId,
        { source: ApplicationSource.referral },
        await tokenFor(recruiterA),
      ).expect(404);

      // And it was not modified.
      const stored = await owner.application.findUniqueOrThrow({
        where: { id: foreignId },
        select: { source: true },
      });
      expect(stored.source).toBe(ApplicationSource.other);
    });

    it('a foreign application is refused identically to one that does not exist', async () => {
      const foreignId = await seed(jobB, 'foreign2', ApplicationSource.other);
      const token = await tokenFor(recruiterA);

      const foreign = await patchSource(foreignId, { source: ApplicationSource.referral }, token);
      const absent = await patchSource(randomUUID(), { source: ApplicationSource.referral }, token);

      const strip = (body: Record<string, unknown>) => {
        const { correlationId: _c, instance: _i, ...rest } = body;
        return rest;
      };
      expect(foreign.status).toBe(absent.status);
      expect(strip(foreign.body)).toEqual(strip(absent.body));
    });
  });

  describe('audit (amendment C3)', () => {
    it('writes application.source_changed with both values', async () => {
      const id = await seed(jobA, 'audited', ApplicationSource.job_board);

      await patchSource(
        id,
        { source: ApplicationSource.referral },
        await tokenFor(recruiterA),
      ).expect(200);

      const record = await owner.auditLog.findFirst({
        where: { action: 'application.source_changed', resourceId: id },
        orderBy: { createdAt: 'desc' },
      });

      expect(record).not.toBeNull();
      expect(record?.companyId).toBe(companyA);
      expect(record?.actorId).toBe(recruiterA);
      expect(record?.actorType).toBe('USER');
      expect(record?.correlationId).toBeTruthy();
      expect(record?.beforeState).toMatchObject({ source: ApplicationSource.job_board });
      expect(record?.afterState).toMatchObject({ source: ApplicationSource.referral });
    });

    it('writes no source_changed record for the initial capture', async () => {
      const response = await submit({
        jobId: jobA,
        fullName: 'Src Capture',
        email: `srccapture.${suffix}@test.local`,
        source: ApplicationSource.referral,
      }).expect(201);

      const changed = await owner.auditLog.count({
        where: { action: 'application.source_changed', resourceId: response.body.id },
      });
      expect(changed).toBe(0);

      // It is inside application.submitted instead.
      const submitted = await owner.auditLog.count({
        where: { action: 'application.submitted', resourceId: response.body.id },
      });
      expect(submitted).toBe(1);
    });
  });

  describe('candidate visibility (D33)', () => {
    it('withholds source from the candidate who owns the application', async () => {
      const id = await seed(jobA, 'candview', ApplicationSource.referral);
      const candidateRow = await owner.application.findUniqueOrThrow({
        where: { id },
        select: { candidateId: true },
      });
      // Link the application's candidate to the login, so ownership resolves.
      await owner.candidate.update({
        where: { id: candidateRow.candidateId },
        data: { userId: candidateUser },
      });

      const response = await request(app.getHttpServer())
        .get(`/applications/${id}`)
        .set(auth(await tokenFor(candidateUser)))
        .expect(200);

      expect(response.body.source).toBeNull();

      // Detach again so other assertions are unaffected.
      await owner.candidate.update({
        where: { id: candidateRow.candidateId },
        data: { userId: null },
      });
    });

    it('shows source to a Recruiter reading the same application', async () => {
      const id = await seed(jobA, 'recview', ApplicationSource.referral);

      const response = await request(app.getHttpServer())
        .get(`/applications/${id}`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(response.body.source).toBe(ApplicationSource.referral);
    });
  });
});
