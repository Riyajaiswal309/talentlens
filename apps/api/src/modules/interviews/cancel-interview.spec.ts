import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InterviewStatus, JobStatus, UserRole } from '@prisma/client';
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
import { NotificationsModule } from '../notifications/notifications.module';
import { TokenService } from '../auth/token.service';
import { CalendarModule } from '../calendar/calendar.module';
import { JobsModule } from '../jobs/jobs.module';
import { InterviewsModule } from './interviews.module';
import type { NextFunction, Response } from 'express';
import type { RequestContext } from '../../common/types/authenticated-request';

/**
 * FR6 — interview cancellation.
 *
 * THE ASSERTION THAT MATTERS IS THE LINK. Cancelling is not only a status
 * change: an outstanding self-service link must stop working the moment it
 * commits, and it does so because both scheduling routes refuse anything that
 * is not PENDING_SELECTION. That coupling is tested here rather than assumed,
 * because nothing else would catch it if the scheduling guard were relaxed.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Interview cancellation (FR6)', () => {
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
  let candidateA = '';
  let recruiterB = '';
  let jobA = '';
  let applicationA = '';
  let candidateRowA = '';
  let applicationB = '';
  let candidateRowB = '';

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());

  async function tokenFor(userId: string): Promise<string> {
    const user = await prisma.users.findUniqueOrThrow({ where: { id: userId } });
    return tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    });
  }

  /** A fresh self-service interview with one offered slot, plus its link. */
  async function makeInterview(applicationId: string, actor: string) {
    const start = new Date(Date.now() + 3 * 864e5).toISOString();
    const response = await http()
      .post('/interviews')
      .set(auth(await tokenFor(actor)))
      .send({
        applicationId,
        slots: [
          {
            startsAt: start,
            endsAt: new Date(Date.parse(start) + 36e5).toISOString(),
            timezone: 'Asia/Kolkata',
          },
        ],
      })
      .expect(201);

    return {
      id: response.body.id as string,
      token: response.body.schedulingToken as string,
      slotId: response.body.slots[0].slotId as string,
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        NotificationsModule,
        AuthModule,
        JobsModule,
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

    const a = await prisma.company.create({ data: { name: `Cx ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `CxB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    const mk = async (companyId: string, role: UserRole, tag: string) =>
      (
        await prisma.users.create({
          data: { companyId, role, email: `cx-${tag}.${suffix}@test.local`, passwordHash: 'x' },
        })
      ).id;

    recruiterA = await mk(companyA, UserRole.RECRUITER, 'rec-a');
    adminA = await mk(companyA, UserRole.ADMIN, 'adm-a');
    hmA = await mk(companyA, UserRole.HIRING_MANAGER, 'hm-a');
    candidateA = await mk(companyA, UserRole.CANDIDATE, 'cand-a');
    recruiterB = await mk(companyB, UserRole.RECRUITER, 'rec-b');

    const mkJobApp = async (companyId: string, creator: string, tag: string) => {
      const job = await prisma.job.create({
        data: {
          companyId,
          createdBy: creator,
          title: `Cx ${tag} ${suffix}`,
          status: JobStatus.PUBLISHED,
        },
      });
      const candidate = await prisma.candidate.create({
        data: { fullName: `Cx ${tag}`, email: `cx-c-${tag}.${suffix}@test.local` },
      });
      const application = await prisma.application.create({
        data: { jobId: job.id, candidateId: candidate.id, currentStage: 'Interview' },
      });
      return { jobId: job.id, applicationId: application.id, candidateId: candidate.id };
    };

    const inA = await mkJobApp(companyA, recruiterA, 'a');
    jobA = inA.jobId;
    applicationA = inA.applicationId;
    candidateRowA = inA.candidateId;

    const inB = await mkJobApp(companyB, recruiterB, 'b');
    applicationB = inB.applicationId;
    candidateRowB = inB.candidateId;

    // The Hiring Manager is assigned, so any refusal below is about the ROLE
    // rather than about assignment scoping.
    await prisma.jobAssignment.create({ data: { jobId: jobA, userId: hmA } });
  });

  afterAll(async () => {
    try {
      const scope = { application: { job: { companyId: { in: [companyA, companyB] } } } };
      await owner.interview.deleteMany({ where: scope });
      await owner.jobAssignment.deleteMany({
        where: { job: { companyId: { in: [companyA, companyB] } } },
      });
      await owner.auditLog.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
      await owner.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
      await owner.candidate.deleteMany({
        where: { id: { in: [candidateRowA, candidateRowB] } },
      });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  afterEach(async () => {
    // Interviews reference `created_by` (RESTRICT), so they are cleared between
    // tests rather than accumulating into the company teardown above.
    await owner.interview.deleteMany({
      where: { application: { job: { companyId: { in: [companyA, companyB] } } } },
    });
  });

  describe('access control', () => {
    it('allows a Recruiter', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);
    });

    it('allows an Administrator', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);
    });

    it('refuses a Hiring Manager even on an ASSIGNED job (D26 — read, not write)', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(hmA)))
        .expect(403);
    });

    it('refuses a Candidate', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(candidateA)))
        .expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      await http().post(`/interviews/${interview.id}/cancel`).expect(401);
    });
  });

  describe('tenant isolation', () => {
    it('another tenant’s interview is 404, not 403 (BR-06)', async () => {
      const interview = await makeInterview(applicationB, recruiterB);
      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(404);
    });

    it('the foreign interview is untouched by the refused attempt', async () => {
      const interview = await makeInterview(applicationB, recruiterB);
      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(404);

      const stored = await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } });
      expect(stored.status).toBe(InterviewStatus.PENDING_SELECTION);
    });

    it('an unknown id is 404, indistinguishable from a foreign one', async () => {
      await http()
        .post(`/interviews/${randomUUID()}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(404);
    });

    /*
     * 400, not the 404 the job-scoped routes give. This route carries an
     * interview id and no `@JobScoped()`, so `JobAssignmentGuard` never runs
     * and `ParseUUIDPipe` is reached — which is the right answer here: the id
     * space being probed is not a tenant's, so BR-06 is not engaged. What
     * matters is that it is never a 500.
     */
    it('a malformed id is a clean 400, never a 500', async () => {
      await http()
        .post('/interviews/not-a-uuid/cancel')
        .set(auth(await tokenFor(recruiterA)))
        .expect(400);
    });
  });

  describe('state transitions', () => {
    it('cancels a PENDING_SELECTION interview', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      const response = await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(response.body.status).toBe('CANCELLED');
      const stored = await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } });
      expect(stored.status).toBe(InterviewStatus.CANCELLED);
    });

    it('cancels an already SCHEDULED interview', async () => {
      const interview = await makeInterview(applicationA, recruiterA);

      // The candidate books first, so the interview is SCHEDULED, not pending.
      await http()
        .post(`/scheduling/${interview.token}/confirm`)
        .send({ slotId: interview.slotId })
        .expect(200);

      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const stored = await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } });
      expect(stored.status).toBe(InterviewStatus.CANCELLED);
    });

    it('cancelling twice is 409, not a silent success', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      const token = await tokenFor(recruiterA);

      await http().post(`/interviews/${interview.id}/cancel`).set(auth(token)).expect(200);
      await http().post(`/interviews/${interview.id}/cancel`).set(auth(token)).expect(409);
    });

    it('preserves calendar_event_id rather than erasing the record', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      const before = await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } });

      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const after = await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } });
      expect(after.calendarEventId).toBe(before.calendarEventId);
    });
  });

  describe('the scheduling link dies with the interview', () => {
    it('a cancelled interview’s link cannot be READ — 410', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      await http().get(`/scheduling/${interview.token}`).expect(200);

      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      await http().get(`/scheduling/${interview.token}`).expect(410);
    });

    it('a cancelled interview CANNOT be booked — 410', async () => {
      const interview = await makeInterview(applicationA, recruiterA);

      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      await http()
        .post(`/scheduling/${interview.token}/confirm`)
        .send({ slotId: interview.slotId })
        .expect(410);

      const stored = await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } });
      expect(stored.status).toBe(InterviewStatus.CANCELLED);
      expect(stored.selectedSlotId).toBeNull();
    });
  });

  describe('audit', () => {
    it('writes NO audit row — Table I.1 names no interview action (D19)', async () => {
      const interview = await makeInterview(applicationA, recruiterA);
      await http()
        .post(`/interviews/${interview.id}/cancel`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const rows = await prisma.auditLog.findMany({ where: { companyId: companyA } });
      expect(rows).toHaveLength(0);
    });
  });
});
