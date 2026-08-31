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
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TokenService } from '../auth/token.service';
import { JobsModule } from './jobs.module';
import type { NextFunction, Response } from 'express';
import type { RequestContext } from '../../common/types/authenticated-request';

/**
 * FR1 / §24.2 — the job assignment write path (amendment B12).
 *
 * THE POINT OF THESE TESTS IS THE LOOP, not the CRUD. `job_assignments` was
 * readable and enforceable long before it was writable, so what matters is that
 * a row created here actually grants a Hiring Manager access to a job that was
 * a 404 a moment earlier, and that removing it revokes that access at once.
 * Everything else guards the edges of that: a Hiring Manager must never be able
 * to assign anyone (they would be widening their own reach), and a target user
 * outside the tenant must be indistinguishable from one that does not exist.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

/** The one message both "no such user" and "another tenant's user" produce. */
const SAFE_USER_MESSAGE = 'That user is not a member of this company';

describe('Job assignments (FR1, §24.2, B12)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  let companyA = '';
  let companyB = '';
  let recruiterA = '';
  let adminA = '';
  let hmA = '';
  let hmOther = '';
  let candidateA = '';
  let jobA = '';
  let closedJobA = '';
  let recruiterB = '';
  let hmB = '';
  let jobB = '';
  /** Resolved in beforeAll so `it.each` tables can be built without awaiting. */
  let recruiterToken = '';

  async function tokenFor(userId: string): Promise<string> {
    const user = await prisma.users.findUniqueOrThrow({ where: { id: userId } });
    return tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    });
  }
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const assign = (token: string, jobId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/jobs/${jobId}/assignments`)
      .set(auth(token))
      .send(body as object);

  const unassign = (token: string, jobId: string, userId: string) =>
    request(app.getHttpServer()).delete(`/jobs/${jobId}/assignments/${userId}`).set(auth(token));

  const listAssignments = (token: string, jobId: string) =>
    request(app.getHttpServer()).get(`/jobs/${jobId}/assignments`).set(auth(token));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        AuthModule,
        JobsModule,
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

    const a = await prisma.company.create({
      data: { name: `Asg A ${suffix}`, dataRegion: 'test' },
    });
    const b = await prisma.company.create({
      data: { name: `Asg B ${suffix}`, dataRegion: 'test' },
    });
    companyA = a.id;
    companyB = b.id;

    const mk = async (companyId: string, role: UserRole, tag: string) =>
      (
        await prisma.users.create({
          data: { companyId, role, email: `asg-${tag}.${suffix}@test.local`, passwordHash: 'x' },
        })
      ).id;

    recruiterA = await mk(companyA, UserRole.RECRUITER, 'rec-a');
    adminA = await mk(companyA, UserRole.ADMIN, 'adm-a');
    hmA = await mk(companyA, UserRole.HIRING_MANAGER, 'hm-a');
    hmOther = await mk(companyA, UserRole.HIRING_MANAGER, 'hm-a2');
    candidateA = await mk(companyA, UserRole.CANDIDATE, 'cand-a');
    recruiterB = await mk(companyB, UserRole.RECRUITER, 'rec-b');
    hmB = await mk(companyB, UserRole.HIRING_MANAGER, 'hm-b');

    const mkJob = async (companyId: string, createdBy: string, status: JobStatus, tag: string) =>
      (
        await prisma.job.create({
          data: { companyId, createdBy, title: `Asg ${tag} ${suffix}`, status },
        })
      ).id;

    jobA = await mkJob(companyA, recruiterA, JobStatus.PUBLISHED, 'open');
    closedJobA = await mkJob(companyA, recruiterA, JobStatus.CLOSED, 'closed');
    jobB = await mkJob(companyB, recruiterB, JobStatus.PUBLISHED, 'foreign');

    recruiterToken = await tokenFor(recruiterA);
  });

  afterAll(async () => {
    try {
      const companies = [companyA, companyB];
      await owner.jobAssignment.deleteMany({ where: { job: { companyId: { in: companies } } } });
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  beforeEach(async () => {
    // Each test starts from "nobody is assigned", so grant/revoke tests cannot
    // pass on a row a previous test happened to leave behind.
    await owner.jobAssignment.deleteMany({
      where: { job: { companyId: { in: [companyA, companyB] } } },
    });
    await owner.auditLog.deleteMany({
      where: { companyId: { in: [companyA, companyB] }, action: { startsWith: 'job.assignment' } },
    });
  });

  describe('access control', () => {
    it('refuses an unauthenticated caller', async () => {
      await request(app.getHttpServer())
        .post(`/jobs/${jobA}/assignments`)
        .send({ userId: hmA })
        .expect(401);
    });

    it('refuses a Candidate', async () => {
      await assign(await tokenFor(candidateA), jobA, { userId: hmA }).expect(403);
    });

    it('refuses a Hiring Manager assigning someone else — no widening their reach', async () => {
      await assign(await tokenFor(hmA), jobA, { userId: hmOther }).expect(403);
    });

    it('refuses a Hiring Manager assigning THEMSELVES (privilege escalation)', async () => {
      await assign(await tokenFor(hmA), jobA, { userId: hmA }).expect(403);
    });

    it('refuses a Hiring Manager removing an assignment', async () => {
      await prisma.jobAssignment.create({ data: { jobId: jobA, userId: hmA } });
      await unassign(await tokenFor(hmA), jobA, hmA).expect(403);
    });

    it('allows a Recruiter', async () => {
      await assign(await tokenFor(recruiterA), jobA, { userId: hmA }).expect(201);
    });

    it('allows an Administrator', async () => {
      await assign(await tokenFor(adminA), jobA, { userId: hmA }).expect(201);
    });
  });

  describe('tenant isolation', () => {
    it('a job in another tenant is 404, not 403', async () => {
      await assign(await tokenFor(recruiterA), jobB, { userId: hmA }).expect(404);
    });

    it('a target user in another tenant is 400 with the safe message', async () => {
      const response = await assign(await tokenFor(recruiterA), jobA, { userId: hmB }).expect(400);
      expect(response.body.detail).toBe(SAFE_USER_MESSAGE);
    });

    it('a target user that does not exist gives the SAME message (BR-06)', async () => {
      const response = await assign(await tokenFor(recruiterA), jobA, {
        userId: randomUUID(),
      }).expect(400);
      expect(response.body.detail).toBe(SAFE_USER_MESSAGE);
    });

    it('cannot assign a foreign user by naming a foreign job either', async () => {
      await assign(await tokenFor(recruiterA), jobB, { userId: hmB }).expect(404);
    });
  });

  describe('who may be assigned', () => {
    it('accepts a Hiring Manager', async () => {
      const response = await assign(await tokenFor(recruiterA), jobA, { userId: hmA }).expect(201);
      expect(response.body.role).toBe('HIRING_MANAGER');
      expect(response.body.userId).toBe(hmA);
    });

    it('accepts an Administrator — D7 scopes their review queue the same way', async () => {
      await assign(await tokenFor(recruiterA), jobA, { userId: adminA }).expect(201);
    });

    it('refuses a Candidate with 400', async () => {
      await assign(await tokenFor(recruiterA), jobA, { userId: candidateA }).expect(400);
    });

    it('refuses a Recruiter with 400 — the row would be inert', async () => {
      const response = await assign(await tokenFor(recruiterA), jobA, {
        userId: recruiterA,
      }).expect(400);
      expect(response.body.detail).toMatch(/already reach/i);
    });
  });

  describe('validation', () => {
    it('refuses a missing userId', async () => {
      await assign(await tokenFor(recruiterA), jobA, {}).expect(400);
    });

    it('refuses a userId that is not a uuid', async () => {
      await assign(await tokenFor(recruiterA), jobA, { userId: 'not-a-uuid' }).expect(400);
    });

    it('refuses an undeclared body property', async () => {
      await assign(await tokenFor(recruiterA), jobA, { userId: hmA, role: 'ADMIN' }).expect(400);
    });

    /*
     * A MALFORMED JOB ID IS A 404, ACROSS EVERY `@JobScoped()` ROUTE.
     *
     * It used to be a 500: `JobAssignmentGuard` runs before `ParseUUIDPipe`, so
     * the raw segment reached Postgres as a `uuid` comparison. The shape is now
     * checked in the guard. `GET /jobs/:id` is asserted alongside the new
     * routes because the defect belonged to the guard, not to these three — a
     * fix that only covered the new routes would have missed the point.
     */
    it.each([
      ['POST assignments', () => assign(recruiterToken, 'not-a-uuid', { userId: hmA })],
      ['GET assignments', () => listAssignments(recruiterToken, 'not-a-uuid')],
      ['DELETE assignment', () => unassign(recruiterToken, 'not-a-uuid', hmA)],
      [
        'GET /jobs/:id (pre-existing route)',
        () => request(app.getHttpServer()).get('/jobs/not-a-uuid').set(auth(recruiterToken)),
      ],
    ])('%s answers 404 for a malformed job id, never 500', async (_label, call) => {
      await call().expect(404);
    });

    it('a well-formed but unknown job id is still 404', async () => {
      await assign(recruiterToken, '11111111-1111-4111-8111-111111111111', {
        userId: hmA,
      }).expect(404);
    });
  });

  describe('duplicates and removal', () => {
    it('refuses a duplicate assignment with 409', async () => {
      const token = await tokenFor(recruiterA);
      await assign(token, jobA, { userId: hmA }).expect(201);
      await assign(token, jobA, { userId: hmA }).expect(409);
    });

    it('removes an assignment with 204', async () => {
      const token = await tokenFor(recruiterA);
      await assign(token, jobA, { userId: hmA }).expect(201);
      await unassign(token, jobA, hmA).expect(204);

      const remaining = await prisma.jobAssignment.findMany({ where: { jobId: jobA } });
      expect(remaining).toHaveLength(0);
    });

    it('removing an assignment that does not exist is 404, not a silent 204', async () => {
      await unassign(await tokenFor(recruiterA), jobA, hmA).expect(404);
    });
  });

  describe('listing', () => {
    it('lists the assigned users with email and role', async () => {
      const token = await tokenFor(recruiterA);
      await assign(token, jobA, { userId: hmA }).expect(201);

      const response = await listAssignments(token, jobA).expect(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].userId).toBe(hmA);
      expect(response.body.data[0].email).toContain('asg-hm-a.');
      expect(Object.keys(response.body.data[0]).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'role',
        'userId',
      ]);
    });

    it('returns an empty list rather than 404 when nobody is assigned', async () => {
      const response = await listAssignments(await tokenFor(recruiterA), jobA).expect(200);
      expect(response.body.data).toEqual([]);
    });

    it('refuses to list a job in another tenant', async () => {
      await listAssignments(await tokenFor(recruiterA), jobB).expect(404);
    });
  });

  describe('the loop: assignment actually grants and revokes access', () => {
    /** Status only — the assertion here is reachability, not the payload. */
    const readJobStatus = async (userId: string, jobId: string): Promise<number> => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${jobId}`)
        .set(auth(await tokenFor(userId)));
      return response.status;
    };

    it('an unassigned Hiring Manager cannot read the job', async () => {
      expect(await readJobStatus(hmA, jobA)).toBe(404);
    });

    it('assigning grants that Hiring Manager access immediately', async () => {
      expect(await readJobStatus(hmA, jobA)).toBe(404);
      await assign(await tokenFor(recruiterA), jobA, { userId: hmA }).expect(201);
      expect(await readJobStatus(hmA, jobA)).toBe(200);
    });

    it('removing the assignment revokes access immediately', async () => {
      const token = await tokenFor(recruiterA);
      await assign(token, jobA, { userId: hmA }).expect(201);
      expect(await readJobStatus(hmA, jobA)).toBe(200);

      await unassign(token, jobA, hmA).expect(204);
      expect(await readJobStatus(hmA, jobA)).toBe(404);
    });

    it('assigning one Hiring Manager grants nothing to another', async () => {
      await assign(await tokenFor(recruiterA), jobA, { userId: hmA }).expect(201);
      expect(await readJobStatus(hmOther, jobA)).toBe(404);
    });
  });

  describe('closed jobs', () => {
    it('allows assignment on a CLOSED job — reviewers still read a closed role', async () => {
      await assign(await tokenFor(recruiterA), closedJobA, { userId: hmA }).expect(201);
    });

    it('allows removal on a CLOSED job', async () => {
      const token = await tokenFor(recruiterA);
      await assign(token, closedJobA, { userId: hmA }).expect(201);
      await unassign(token, closedJobA, hmA).expect(204);
    });
  });

  describe('audit trail (C5)', () => {
    it('records job.assignment_added against the JOB, naming the colleague', async () => {
      await assign(await tokenFor(recruiterA), jobA, { userId: hmA }).expect(201);

      const row = await prisma.auditLog.findFirst({
        where: { companyId: companyA, action: 'job.assignment_added', resourceId: jobA },
      });
      expect(row).not.toBeNull();
      expect(row?.resourceType).toBe('job');
      expect(row?.actorId).toBe(recruiterA);
      expect(row?.beforeState).toBeNull();
      expect(row?.afterState).toMatchObject({ userId: hmA, role: 'HIRING_MANAGER' });
    });

    it('records job.assignment_removed carrying what stopped applying', async () => {
      const token = await tokenFor(recruiterA);
      await assign(token, jobA, { userId: hmA }).expect(201);
      await unassign(token, jobA, hmA).expect(204);

      const row = await prisma.auditLog.findFirst({
        where: { companyId: companyA, action: 'job.assignment_removed', resourceId: jobA },
      });
      expect(row).not.toBeNull();
      expect(row?.beforeState).toMatchObject({ userId: hmA, role: 'HIRING_MANAGER' });
      expect(row?.afterState).toBeNull();
    });

    it('writes no audit row when the assignment was refused', async () => {
      await assign(await tokenFor(recruiterA), jobA, { userId: candidateA }).expect(400);

      const rows = await prisma.auditLog.findMany({
        where: { companyId: companyA, action: { startsWith: 'job.assignment' } },
      });
      expect(rows).toHaveLength(0);
    });
  });
});
