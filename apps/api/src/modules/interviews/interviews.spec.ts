import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { InterviewStatus, JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { InterviewsModule } from './interviews.module';
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
 * FR6.1–FR6.3 — the hiring team's side of interview scheduling.
 *
 * The two creation paths are the substance: FR6.2 offers slots and issues a
 * link, FR6.3 books a time directly. Everything else checks that this module
 * obeys the same tenancy and role rules as the ones built before it.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Interviews (FR6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let jobs: JobsService;
  let applications: ApplicationsService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;

  let companyA = '';
  let companyB = '';
  let recruiterA = '';
  let adminA = '';
  let hmAssigned = '';
  let hmUnassigned = '';
  let recruiterB = '';
  let candidateUser = '';
  let jobAssigned = '';
  let applicationId = '';
  let applicationB = '';

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

  const create = (body: object, token: string) =>
    request(app.getHttpServer()).post('/interviews').set(auth(token)).send(body);

  const list = (id: string, token: string) =>
    request(app.getHttpServer()).get(`/applications/${id}/interviews`).set(auth(token));

  /** Two windows next week, so `expiresAt` is always in the future. */
  const slots = () => {
    const base = Date.now() + 7 * 24 * 60 * 60 * 1000;
    return [
      {
        startsAt: new Date(base).toISOString(),
        endsAt: new Date(base + 60 * 60 * 1000).toISOString(),
        timezone: 'Europe/London',
      },
      {
        startsAt: new Date(base + 24 * 60 * 60 * 1000).toISOString(),
        endsAt: new Date(base + 25 * 60 * 60 * 1000).toISOString(),
        timezone: 'Europe/London',
      },
    ];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        NotificationsModule,
        AuthModule,
        JobsModule,
        ApplicationsModule,
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
    jobs = moduleRef.get(JobsService);
    applications = moduleRef.get(ApplicationsService);
    tokens = moduleRef.get(TokenService);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `IvA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `IvB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
      });
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'iv-rec-a');
    adminA = await makeUser(companyA, UserRole.ADMIN, 'iv-adm-a');
    hmAssigned = await makeUser(companyA, UserRole.HIRING_MANAGER, 'iv-hm-yes');
    hmUnassigned = await makeUser(companyA, UserRole.HIRING_MANAGER, 'iv-hm-no');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'iv-rec-b');
    candidateUser = await makeUser(companyA, UserRole.CANDIDATE, 'iv-cand');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `iv-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: recruiterB,
      email: `iv-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    const created = await jobs.create(recA, { title: `Iv job ${suffix}` });
    await jobs.update(recA, created.id, { status: JobStatus.PUBLISHED });
    jobAssigned = created.id;
    await prisma.jobAssignment.create({ data: { jobId: jobAssigned, userId: hmAssigned } });

    const createdB = await jobs.create(recB, { title: `Iv jobB ${suffix}` });
    await jobs.update(recB, createdB.id, { status: JobStatus.PUBLISHED });

    applicationId = (
      await applications.submit(
        { jobId: jobAssigned, fullName: 'Iv Candidate', email: `ivcand.${suffix}@test.local` },
        pdf(),
        CORRELATION,
      )
    ).application.id;

    applicationB = (
      await applications.submit(
        { jobId: createdB.id, fullName: 'Iv Other', email: `ivother.${suffix}@test.local` },
        pdf(),
        CORRELATION,
      )
    ).application.id;
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

      // Interviews first: `created_by` and the panel are RESTRICT against
      // `users`, so a company delete would fail while any interview survives.
      await owner.interview.updateMany({
        where: { applicationId: { in: applicationIds } },
        data: { selectedSlotId: null },
      });
      await owner.interview.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
      await owner.candidate.deleteMany({ where: { email: { contains: suffix } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  describe('FR6.2 — self-service, slots offered', () => {
    it('creates a PENDING_SELECTION interview and returns a scheduling link', async () => {
      const response = await create(
        { applicationId, slots: slots(), interviewerIds: [hmAssigned] },
        await tokenFor(recruiterA),
      ).expect(201);

      expect(response.body).toMatchObject({
        applicationId,
        status: InterviewStatus.PENDING_SELECTION,
        scheduledAt: null,
        // FR6.3 — no provider configured, so no event id. Not an error.
        calendarEventId: null,
        selectedSlotId: null,
      });
      expect(response.body.slots).toHaveLength(2);
      expect(response.body.interviewers).toEqual([
        { id: hmAssigned, email: `iv-hm-yes.${suffix}@test.local` },
      ]);
      expect(typeof response.body.schedulingToken).toBe('string');
      expect(response.body.schedulingToken).toContain('.');
    });

    it('expires the link when the last slot ends, not at an invented TTL', async () => {
      const offered = slots();
      const response = await create(
        { applicationId, slots: offered },
        await tokenFor(recruiterA),
      ).expect(201);

      const lastSlotEnd = offered
        .map((s) => new Date(s.endsAt).getTime())
        .reduce((a, b) => Math.max(a, b));

      // Signed to whole seconds, so allow the truncation.
      expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThanOrEqual(
        lastSlotEnd - 1000,
      );
      expect(new Date(response.body.expiresAt).getTime()).toBeLessThanOrEqual(lastSlotEnd);
    });

    it('rejects a slot that ends before it starts', async () => {
      const bad = slots();
      bad[0] = { ...bad[0]!, endsAt: bad[0]!.startsAt, startsAt: bad[0]!.endsAt };

      await create({ applicationId, slots: bad }, await tokenFor(recruiterA)).expect(400);
    });
  });

  describe('FR6.3 — manual booking', () => {
    it('books a time directly and is SCHEDULED immediately, with no link', async () => {
      const when = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

      const response = await create(
        { applicationId, scheduledAt: when, timezone: 'Europe/London' },
        await tokenFor(adminA),
      ).expect(201);

      expect(response.body).toMatchObject({
        status: InterviewStatus.SCHEDULED,
        timezone: 'Europe/London',
        // The workflow completed with no calendar integration — FR6.3's
        // whole point. A null here is success, not degradation to failure.
        calendarEventId: null,
      });
      expect(new Date(response.body.scheduledAt).toISOString()).toBe(when);
      expect(response.body.schedulingToken).toBeUndefined();
    });

    it('requires a timezone when a time is given', async () => {
      await create(
        { applicationId, scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
        await tokenFor(recruiterA),
      ).expect(400);
    });
  });

  describe('one path or the other', () => {
    it('refuses both slots and scheduledAt together', async () => {
      await create(
        {
          applicationId,
          slots: slots(),
          scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
          timezone: 'Europe/London',
        },
        await tokenFor(recruiterA),
      ).expect(400);
    });

    it('refuses neither', async () => {
      await create({ applicationId }, await tokenFor(recruiterA)).expect(400);
    });
  });

  describe('validation', () => {
    it('rejects a malformed applicationId', async () => {
      await create(
        { applicationId: 'not-a-uuid', slots: slots() },
        await tokenFor(recruiterA),
      ).expect(400);
    });

    it('rejects an unknown query field (forbidNonWhitelisted)', async () => {
      await create(
        { applicationId, slots: slots(), sendEmail: true },
        await tokenFor(recruiterA),
      ).expect(400);
    });

    it('rejects a timezone that is not an IANA zone name', async () => {
      await create(
        {
          applicationId,
          scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
          timezone: 'GMT+1; DROP TABLE interviews',
        },
        await tokenFor(recruiterA),
      ).expect(400);
    });

    it('rejects duplicate interviewerIds', async () => {
      await create(
        { applicationId, slots: slots(), interviewerIds: [hmAssigned, hmAssigned] },
        await tokenFor(recruiterA),
      ).expect(400);
    });
  });

  describe('RBAC (PRD §23.2 — Recruiter, Admin)', () => {
    it('a Hiring Manager may not schedule', async () => {
      await create({ applicationId, slots: slots() }, await tokenFor(hmAssigned)).expect(403);
    });

    it('a Candidate may not schedule', async () => {
      await create({ applicationId, slots: slots() }, await tokenFor(candidateUser)).expect(403);
    });

    it('an unauthenticated caller may not schedule', async () => {
      await request(app.getHttpServer())
        .post('/interviews')
        .send({ applicationId, slots: slots() })
        .expect(401);
    });
  });

  describe('tenant isolation (BR-06 — 404, never 403)', () => {
    it("refuses another company's application with 404", async () => {
      await create(
        { applicationId: applicationB, slots: slots() },
        await tokenFor(recruiterA),
      ).expect(404);
    });

    it('returns the same body for a foreign application as for one that does not exist', async () => {
      const token = await tokenFor(recruiterA);
      const foreign = await create({ applicationId: applicationB, slots: slots() }, token).expect(
        404,
      );
      const absent = await create({ applicationId: randomUUID(), slots: slots() }, token).expect(
        404,
      );

      /*
       * Everything except `correlationId`, which is unique per request by
       * design (NFR11). Comparing the whole remaining body rather than just
       * `detail` catches a future field that would distinguish the two — the
       * disclosure BR-06 forbids does not have to be in the message.
       */
      const withoutCorrelation = (body: Record<string, unknown>) => {
        const { correlationId: _correlationId, ...rest } = body;
        return rest;
      };

      expect(withoutCorrelation(foreign.body)).toEqual(withoutCorrelation(absent.body));
      expect(foreign.body.correlationId).not.toBe(absent.body.correlationId);
    });

    it("refuses an interviewer from another company's staff", async () => {
      await create(
        { applicationId, slots: slots(), interviewerIds: [recruiterB] },
        await tokenFor(recruiterA),
      ).expect(400);
    });
  });

  describe('reading interviews on an application', () => {
    it('lists them newest first for a Recruiter', async () => {
      const response = await list(applicationId, await tokenFor(recruiterA)).expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
      const timestamps = response.body.data.map((i: { createdAt: string }) =>
        new Date(i.createdAt).getTime(),
      );
      expect([...timestamps].sort((a: number, b: number) => b - a)).toEqual(timestamps);
    });

    it('an assigned Hiring Manager can read them (RC-06)', async () => {
      await list(applicationId, await tokenFor(hmAssigned)).expect(200);
    });

    it('an unassigned Hiring Manager gets 404, not 403', async () => {
      await list(applicationId, await tokenFor(hmUnassigned)).expect(404);
    });

    it('a Candidate cannot read the interview list', async () => {
      await list(applicationId, await tokenFor(candidateUser)).expect(403);
    });
  });

  describe('audit', () => {
    /**
     * Handoff §I Table I.1 has no interview event, so nothing is written.
     * The same ruling already governs scorecards and comments; this test
     * pins it so a future change is a deliberate vocabulary decision rather
     * than an accident.
     */
    it('writes no audit record — Table I.1 names no interview action', async () => {
      const before = await owner.auditLog.count({ where: { companyId: companyA } });

      await create({ applicationId, slots: slots() }, await tokenFor(recruiterA)).expect(201);

      expect(await owner.auditLog.count({ where: { companyId: companyA } })).toBe(before);
    });
  });
});
