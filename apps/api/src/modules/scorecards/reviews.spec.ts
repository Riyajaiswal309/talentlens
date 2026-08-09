import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ScorecardsModule } from './scorecards.module';
import { ApplicationsModule } from '../applications/applications.module';
import { ApplicationsService } from '../applications/applications.service';
import { CommonModule } from '../../common/common.module';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { CandidateOwnershipGuard } from '../../common/guards/candidate-ownership.guard';
import { JobAssignmentGuard } from '../../common/guards/job-assignment.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
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
 * GET /v1/me/reviews — Handoff §B row 19 / Gap 1, Phase 1 HM-01.
 *
 * The queue is DERIVED — no review-request entity exists — so the tests below
 * pin the derivation itself: which applications appear, when one leaves the
 * pending tab, and that the scope cannot be widened by the caller.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('GET /me/reviews (Handoff Gap 1)', () => {
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
  let hmAssigned = '';
  let hmOther = '';
  let hmNoAssignments = '';
  let adminAssigned = '';
  let adminNoAssignments = '';
  let candidateUser = '';
  let hmInB = '';

  let assignedJob = '';
  let unassignedJob = '';
  let jobInB = '';

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
      { jobId: job, fullName: `Rev ${tag}`, email: `${tag}.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
    return result.application.id;
  }

  function reviews(token: string, query = '') {
    return request(app.getHttpServer()).get(`/me/reviews${query}`).set(auth(token));
  }

  const idsIn = (body: { data: { applicationId: string }[] }) =>
    body.data.map((row) => row.applicationId);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        AuthModule,
        JobsModule,
        ApplicationsModule,
        ScorecardsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: RequestContext, res: Response, next: NextFunction) =>
      new CorrelationIdMiddleware().use(req, res, next),
    );

    const reflector = app.get(Reflector);
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

    const a = await prisma.company.create({ data: { name: `RevA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `RevB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local` },
      });
      userIds.push(user.id);
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'rev-rec');
    hmAssigned = await makeUser(companyA, UserRole.HIRING_MANAGER, 'rev-hm-yes');
    hmOther = await makeUser(companyA, UserRole.HIRING_MANAGER, 'rev-hm-other');
    hmNoAssignments = await makeUser(companyA, UserRole.HIRING_MANAGER, 'rev-hm-none');
    adminAssigned = await makeUser(companyA, UserRole.ADMIN, 'rev-admin-yes');
    adminNoAssignments = await makeUser(companyA, UserRole.ADMIN, 'rev-admin-none');
    candidateUser = await makeUser(companyA, UserRole.CANDIDATE, 'rev-cand');
    hmInB = await makeUser(companyB, UserRole.HIRING_MANAGER, 'rev-hm-b');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `rev-rec.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };

    const assigned = await jobs.create(recA, { title: `Rev assigned ${suffix}` });
    await jobs.update(recA, assigned.id, { status: JobStatus.PUBLISHED });
    assignedJob = assigned.id;
    // Both the HM and one Admin are assigned; the other HM/Admin are not.
    await prisma.jobAssignment.create({ data: { jobId: assignedJob, userId: hmAssigned } });
    await prisma.jobAssignment.create({ data: { jobId: assignedJob, userId: adminAssigned } });

    const unassigned = await jobs.create(recA, { title: `Rev unassigned ${suffix}` });
    await jobs.update(recA, unassigned.id, { status: JobStatus.PUBLISHED });
    unassignedJob = unassigned.id;
    await prisma.jobAssignment.create({ data: { jobId: unassignedJob, userId: hmOther } });

    const recB: AuthenticatedUser = {
      id: await makeUser(companyB, UserRole.RECRUITER, 'rev-rec-b'),
      email: `rev-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };
    const inB = await jobs.create(recB, { title: `Rev jobB ${suffix}` });
    await jobs.update(recB, inB.id, { status: JobStatus.PUBLISHED });
    jobInB = inB.id;
    await prisma.jobAssignment.create({ data: { jobId: jobInB, userId: hmInB } });
  });

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

      await owner.scorecard.deleteMany({ where: { applicationId: { in: applicationIds } } });
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
  // The derived queue
  // =========================================================================
  describe('what appears in the queue', () => {
    it('lists an application on an assigned job', async () => {
      const id = await newApplication('q1', assignedJob);

      const response = await reviews(await tokenFor(hmAssigned)).expect(200);

      expect(idsIn(response.body)).toContain(id);
    });

    it('returns the Gap 1 row shape', async () => {
      const id = await newApplication('q2', assignedJob);

      const response = await reviews(await tokenFor(hmAssigned)).expect(200);
      const row = response.body.data.find((r: { applicationId: string }) => r.applicationId === id);

      expect(row).toMatchObject({
        applicationId: id,
        jobId: assignedJob,
        jobTitle: `Rev assigned ${suffix}`,
        candidateName: 'Rev q2',
        scorecardSubmitted: false,
      });
      expect(row.requestedAt).toBeTruthy();
      expect(response.body).toHaveProperty('nextCursor');
    });

    /** No review-request entity exists — requestedAt is when the work arrived. */
    it('requestedAt is the application appliedAt', async () => {
      const id = await newApplication('q3', assignedJob);
      const stored = await prisma.application.findUniqueOrThrow({ where: { id } });

      const response = await reviews(await tokenFor(hmAssigned)).expect(200);
      const row = response.body.data.find((r: { applicationId: string }) => r.applicationId === id);

      expect(row.requestedAt).toBe(stored.appliedAt.toISOString());
    });

    it('excludes applications on a job the caller is NOT assigned to', async () => {
      const mine = await newApplication('q4', assignedJob);
      const notMine = await newApplication('q5', unassignedJob);

      const response = await reviews(await tokenFor(hmAssigned), '?limit=100').expect(200);

      expect(idsIn(response.body)).toContain(mine);
      expect(idsIn(response.body)).not.toContain(notMine);
    });

    it('excludes another tenant entirely', async () => {
      const inOtherTenant = await newApplication('q6', jobInB);

      const response = await reviews(await tokenFor(hmAssigned), '?limit=100').expect(200);
      expect(idsIn(response.body)).not.toContain(inOtherTenant);
    });

    /** Gap 1: "HM has no assignments — an empty queue is not an error". */
    it('an HM with no assignments gets 200 and an empty list', async () => {
      const response = await reviews(await tokenFor(hmNoAssignments)).expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.nextCursor).toBeNull();
    });

    it('newest first', async () => {
      const response = await reviews(await tokenFor(hmAssigned), '?limit=100').expect(200);
      const times = response.body.data.map((r: { requestedAt: string }) =>
        new Date(r.requestedAt).getTime(),
      );

      expect([...times].sort((x, y) => y - x)).toEqual(times);
    });
  });

  // =========================================================================
  // pending vs completed
  // =========================================================================
  describe('pending and completed', () => {
    async function scoreAs(applicationId: string, userId: string) {
      await prisma.scorecard.create({ data: { applicationId, authorId: userId, rating: 4 } });
    }

    it('defaults to pending when no status is given', async () => {
      const id = await newApplication('p1', assignedJob);
      await scoreAs(id, hmAssigned);

      const response = await reviews(await tokenFor(hmAssigned), '?limit=100').expect(200);
      expect(idsIn(response.body)).not.toContain(id);
    });

    it('a scored application moves from pending to completed', async () => {
      const id = await newApplication('p2', assignedJob);
      const token = await tokenFor(hmAssigned);

      const before = await reviews(token, '?status=pending&limit=100').expect(200);
      expect(idsIn(before.body)).toContain(id);

      await scoreAs(id, hmAssigned);

      const after = await reviews(token, '?status=pending&limit=100').expect(200);
      expect(idsIn(after.body)).not.toContain(id);

      const completed = await reviews(token, '?status=completed&limit=100').expect(200);
      expect(idsIn(completed.body)).toContain(id);
    });

    it('completed rows report scorecardSubmitted true', async () => {
      const id = await newApplication('p3', assignedJob);
      await scoreAs(id, hmAssigned);

      const response = await reviews(
        await tokenFor(hmAssigned),
        '?status=completed&limit=100',
      ).expect(200);

      const row = response.body.data.find((r: { applicationId: string }) => r.applicationId === id);
      expect(row.scorecardSubmitted).toBe(true);
    });

    /**
     * The queue is personal. A colleague scoring the candidate does not clear
     * this reviewer's own outstanding work.
     */
    it("a COLLEAGUE's scorecard does not clear my pending item", async () => {
      const id = await newApplication('p4', assignedJob);
      await prisma.jobAssignment.create({ data: { jobId: assignedJob, userId: hmOther } });

      await scoreAs(id, hmOther);

      const mine = await reviews(await tokenFor(hmAssigned), '?status=pending&limit=100').expect(
        200,
      );
      expect(idsIn(mine.body)).toContain(id);

      const theirs = await reviews(await tokenFor(hmOther), '?status=completed&limit=100').expect(
        200,
      );
      expect(idsIn(theirs.body)).toContain(id);
    });
  });

  // =========================================================================
  // Administrators
  // =========================================================================
  describe('administrators', () => {
    it('an ASSIGNED Admin sees the queue', async () => {
      const id = await newApplication('a1', assignedJob);

      const response = await reviews(await tokenFor(adminAssigned), '?limit=100').expect(200);
      expect(idsIn(response.body)).toContain(id);
    });

    /**
     * DECISION (flagged): the Gap 1 scoping rule is applied to Admins too, so
     * an Admin holding no assignments has an empty queue rather than the
     * whole tenant. Nothing in the documents grants a wider scope here.
     */
    it('an Admin with NO assignments sees an empty queue', async () => {
      await newApplication('a2', assignedJob);

      const response = await reviews(await tokenFor(adminNoAssignments), '?limit=100').expect(200);
      expect(response.body.data).toEqual([]);
    });
  });

  // =========================================================================
  // Validation (Gap 1 rules 1–2)
  // =========================================================================
  describe('validation', () => {
    it('rejects a status outside the enum', async () => {
      const response = await reviews(await tokenFor(hmAssigned), '?status=archived').expect(400);
      expect(response.body.detail).toMatch(/'pending' or 'completed'/i);
    });

    it('rejects a limit outside 1–100', async () => {
      const token = await tokenFor(hmAssigned);

      const zero = await reviews(token, '?limit=0').expect(400);
      expect(zero.body.detail).toMatch(/between 1 and 100/i);
      await reviews(token, '?limit=101').expect(400);
    });

    it('rejects a malformed cursor with 400, not 500', async () => {
      const response = await reviews(await tokenFor(hmAssigned), '?cursor=nonsense').expect(400);
      expect(response.body.detail).toMatch(/not a valid page marker/i);
    });

    it('honours limit and pages without repeating a row', async () => {
      await newApplication('page1', assignedJob);
      await newApplication('page2', assignedJob);
      const token = await tokenFor(hmAssigned);

      const first = await reviews(token, '?limit=1').expect(200);
      expect(first.body.data).toHaveLength(1);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await reviews(token, `?limit=1&cursor=${first.body.nextCursor}`).expect(200);
      expect(second.body.data[0].applicationId).not.toBe(first.body.data[0].applicationId);
    });

    /**
     * Gap 1 rule 3 / NFR6 — "the client cannot widen this scope by
     * parameter". Any parameter that could is rejected outright.
     */
    it('NFR6: refuses parameters that could widen the scope', async () => {
      const token = await tokenFor(hmAssigned);

      await reviews(token, `?userId=${hmOther}`).expect(400);
      await reviews(token, `?jobId=${unassignedJob}`).expect(400);
      await reviews(token, `?companyId=${companyB}`).expect(400);
    });
  });

  // =========================================================================
  // Authorisation
  // =========================================================================
  describe('authorisation', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/me/reviews').expect(401);
    });

    it('Gap 1: refuses a Recruiter', async () => {
      await reviews(await tokenFor(recruiterA)).expect(403);
    });

    it('Gap 1: refuses a Candidate', async () => {
      await reviews(await tokenFor(candidateUser)).expect(403);
    });

    it('an HM in another tenant sees only their own tenant work', async () => {
      const inB = await newApplication('x1', jobInB);
      const inA = await newApplication('x2', assignedJob);

      const response = await reviews(await tokenFor(hmInB), '?limit=100').expect(200);

      expect(idsIn(response.body)).toContain(inB);
      expect(idsIn(response.body)).not.toContain(inA);
    });
  });
});
