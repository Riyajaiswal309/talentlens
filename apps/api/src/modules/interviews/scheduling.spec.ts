import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { InterviewStatus, JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { CalendarProvider } from './calendar.provider';
import { InterviewsModule } from './interviews.module';
import { InterviewsService } from './interviews.service';
import { SchedulingTokenService } from './scheduling-token.service';
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
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * FR6.2 / Handoff Gap 7 — the candidate's self-service scheduling link.
 *
 * Gap 7 states an exact error table, and most of this file is that table.
 * The security-relevant cases are the ones a candidate could try on purpose:
 * booking a slot from somebody else's interview, replaying a spent link, and
 * presenting a tampered token.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

/** Stands in for a configured provider that is down (Gap 7 `503`). */
class OutageCalendarProvider extends CalendarProvider {
  isAvailable(): boolean {
    return false;
  }
  async createEvent() {
    return null;
  }
}

describe('Self-service scheduling (FR6.2, Handoff Gap 7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let interviews: InterviewsService;
  let schedulingTokens: SchedulingTokenService;
  const outage = new OutageCalendarProvider();
  let providerDown = false;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;

  let companyA = '';
  let recruiterA = '';
  let hmA = '';
  let applicationId = '';
  let recA: AuthenticatedUser;

  const pdf = () =>
    ({
      fieldname: 'resume',
      originalname: 'resume.pdf',
      encoding: '7bit',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
      size: 16,
    }) as Express.Multer.File;

  const offer = (token: string) => request(app.getHttpServer()).get(`/scheduling/${token}`);

  const confirm = (token: string, body: object) =>
    request(app.getHttpServer()).post(`/scheduling/${token}/confirm`).send(body);

  const slots = () => {
    const base = Date.now() + 7 * 24 * 60 * 60 * 1000;
    return [
      {
        startsAt: new Date(base).toISOString(),
        endsAt: new Date(base + 3_600_000).toISOString(),
        timezone: 'Europe/London',
      },
      {
        startsAt: new Date(base + 86_400_000).toISOString(),
        endsAt: new Date(base + 86_400_000 + 3_600_000).toISOString(),
        timezone: 'Europe/London',
      },
    ];
  };

  /** A fresh PENDING_SELECTION interview with its link. */
  async function newOffer() {
    const created = await interviews.create(recA, {
      applicationId,
      slots: slots(),
      interviewerIds: [hmA],
    });
    return { interview: created.interview, token: created.schedulingToken! };
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
        InterviewsModule,
      ],
    })
      /*
       * A switchable provider, so the Gap 7 `503` row and the ordinary
       * success path can both be exercised in one process. `providerDown`
       * is flipped by the one test that needs an outage.
       */
      .overrideProvider(CalendarProvider)
      .useValue({
        isAvailable: () => (providerDown ? outage.isAvailable() : true),
        createEvent: async () => null,
      })
      .compile();

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
    interviews = moduleRef.get(InterviewsService);
    schedulingTokens = moduleRef.get(SchedulingTokenService);
    const jobs = moduleRef.get(JobsService);
    const applications = moduleRef.get(ApplicationsService);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `ScA ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;

    const rec = await prisma.users.create({
      data: {
        companyId: companyA,
        role: UserRole.RECRUITER,
        email: `sc-rec.${suffix}@test.local`,
        passwordHash: 'x',
      },
    });
    recruiterA = rec.id;
    const hm = await prisma.users.create({
      data: {
        companyId: companyA,
        role: UserRole.HIRING_MANAGER,
        email: `sc-hm.${suffix}@test.local`,
        passwordHash: 'x',
      },
    });
    hmA = hm.id;

    recA = {
      id: recruiterA,
      email: rec.email,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };

    const created = await jobs.create(recA, { title: `Sc job ${suffix}` });
    await jobs.update(recA, created.id, { status: JobStatus.PUBLISHED });

    applicationId = (
      await applications.submit(
        { jobId: created.id, fullName: 'Sc Candidate', email: `sccand.${suffix}@test.local` },
        pdf(),
        CORRELATION,
      )
    ).application.id;
  });

  afterAll(async () => {
    try {
      const applicationIds = (
        await owner.application.findMany({
          where: { job: { companyId: companyA } },
          select: { id: true },
        })
      ).map((r) => r.id);

      await owner.interview.updateMany({
        where: { applicationId: { in: applicationIds } },
        data: { selectedSlotId: null },
      });
      await owner.interview.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.auditLog.deleteMany({ where: { companyId: companyA } });
      await owner.company.deleteMany({ where: { id: companyA } });
      await owner.candidate.deleteMany({ where: { email: { contains: suffix } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  describe('GET /v1/scheduling/:token — the offer', () => {
    it("returns Gap 7's exact shape with no session", async () => {
      const { token } = await newOffer();
      const response = await offer(token).expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        'expiresAt',
        'interviewerNames',
        'jobTitle',
        'slots',
      ]);
      expect(response.body.jobTitle).toBe(`Sc job ${suffix}`);
      expect(response.body.interviewerNames).toEqual([`sc-hm.${suffix}`]);
      expect(response.body.slots).toHaveLength(2);
      expect(Object.keys(response.body.slots[0]).sort()).toEqual([
        'endsAt',
        'slotId',
        'startsAt',
        'timezone',
      ]);
    });

    it('discloses nothing beyond the one interview (Gap 7 rule 4, BR-06)', async () => {
      const { token } = await newOffer();
      const response = await offer(token).expect(200);

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(applicationId);
      expect(serialised).not.toContain(companyA);
      expect(serialised).not.toContain(recruiterA);
      // The candidate's own record is not echoed back either.
      expect(serialised).not.toContain('sccand');
    });

    it('401 for a token with a tampered payload', async () => {
      const { token } = await newOffer();
      const [payload, signature] = token.split('.');
      const forged = Buffer.from(
        JSON.stringify({ interviewId: randomUUID(), exp: 4_102_444_800 }),
      ).toString('base64url');

      expect(payload).toBeDefined();
      await offer(`${forged}.${signature}`).expect(401);
    });

    it('401 for a token signed with the wrong key', async () => {
      const foreign = new SchedulingTokenService({
        get: (key: string) =>
          key === 'SCHEDULING_TOKEN_SECRET' ? 'an-attackers-secret' : undefined,
      } as unknown as ConfigService);

      const { interview } = await newOffer();
      const token = foreign.sign(interview.id, new Date(Date.now() + 86_400_000));

      await offer(token).expect(401);
    });

    it('401 for an expired token', async () => {
      const { interview } = await newOffer();
      const expired = schedulingTokens.sign(interview.id, new Date(Date.now() - 1000));

      await offer(expired).expect(401);
    });

    it('401 for a structurally malformed token', async () => {
      await offer('not-a-token').expect(401);
    });

    it('404 when the token verifies but the interview is gone', async () => {
      const orphan = schedulingTokens.sign(randomUUID(), new Date(Date.now() + 86_400_000));
      await offer(orphan).expect(404);
    });
  });

  describe('POST /v1/scheduling/:token/confirm — taking a slot', () => {
    it("books the chosen slot and returns Gap 7's shape", async () => {
      const { interview, token } = await newOffer();
      const chosen = interview.slots[1]!;

      const response = await confirm(token, { slotId: chosen.id }).expect(200);

      expect(response.body).toEqual({
        interviewId: interview.id,
        scheduledAt: chosen.startsAt.toISOString(),
        // No provider configured — FR6.3. A null here is a completed booking.
        calendarEventId: null,
      });

      const stored = await owner.interview.findUniqueOrThrow({ where: { id: interview.id } });
      expect(stored.status).toBe(InterviewStatus.SCHEDULED);
      expect(stored.scheduledAt?.toISOString()).toBe(chosen.startsAt.toISOString());
      expect(stored.selectedSlotId).toBe(chosen.id);
      expect(stored.timezone).toBe('Europe/London');
    });

    it('400 for a malformed slotId', async () => {
      const { token } = await newOffer();
      await confirm(token, { slotId: 'not-a-uuid' }).expect(400);
    });

    it('400 for a slot this token did not offer (Gap 7 rule 2)', async () => {
      const mine = await newOffer();
      const someoneElses = await newOffer();

      // A real, existing slot id — but from a different interview.
      await confirm(mine.token, { slotId: someoneElses.interview.slots[0]!.id }).expect(400);

      // And the other interview is untouched.
      const other = await owner.interview.findUniqueOrThrow({
        where: { id: someoneElses.interview.id },
      });
      expect(other.status).toBe(InterviewStatus.PENDING_SELECTION);
    });

    it('410 when the link has already been spent', async () => {
      const { interview, token } = await newOffer();
      await confirm(token, { slotId: interview.slots[0]!.id }).expect(200);

      await confirm(token, { slotId: interview.slots[1]!.id }).expect(410);
    });

    it('410 when the interview was cancelled', async () => {
      const { interview, token } = await newOffer();
      await owner.interview.update({
        where: { id: interview.id },
        data: { status: InterviewStatus.CANCELLED },
      });

      await offer(token).expect(410);
      await confirm(token, { slotId: interview.slots[0]!.id }).expect(410);
    });

    it('409 when two confirmations race for the same interview', async () => {
      const { interview, token } = await newOffer();

      const [first, second] = await Promise.all([
        confirm(token, { slotId: interview.slots[0]!.id }),
        confirm(token, { slotId: interview.slots[1]!.id }),
      ]);

      /*
       * Gap 7 rule 3 requires a transactional check, not read-then-write.
       * Exactly one must win. Which one is not determined, and both losing
       * codes are correct depending on how the two requests interleave:
       * 409 if both passed the status read, 410 if the second read it after
       * the first had committed.
       */
      const codes = [first.status, second.status].sort();
      expect(codes[0]).toBe(200);
      expect([409, 410]).toContain(codes[1]);

      const stored = await owner.interview.findUniqueOrThrow({ where: { id: interview.id } });
      expect(stored.status).toBe(InterviewStatus.SCHEDULED);
      // The winner's choice stands; the loser did not overwrite it.
      expect(stored.selectedSlotId).toBeTruthy();
    });

    it('503 when a configured calendar provider is down (Gap 7, FR6.3)', async () => {
      const { interview, token } = await newOffer();
      providerDown = true;
      try {
        await confirm(token, { slotId: interview.slots[0]!.id }).expect(503);
      } finally {
        providerDown = false;
      }

      // Nothing was written — the candidate falls back to manual scheduling
      // rather than holding a booking with no invite.
      const stored = await owner.interview.findUniqueOrThrow({ where: { id: interview.id } });
      expect(stored.status).toBe(InterviewStatus.PENDING_SELECTION);
      expect(stored.scheduledAt).toBeNull();
    });

    it('rejects an unknown body field', async () => {
      const { interview, token } = await newOffer();
      await confirm(token, { slotId: interview.slots[0]!.id, notifyMe: true }).expect(400);
    });
  });

  describe('the token is not a session', () => {
    it('cannot be presented as a Bearer access token', async () => {
      const { token } = await newOffer();

      await request(app.getHttpServer())
        .get(`/applications/${applicationId}/interviews`)
        .set({ Authorization: `Bearer ${token}` })
        .expect(401);
    });

    it('carries no identity claims at all', async () => {
      const { interview, token } = await newOffer();
      const claims = JSON.parse(
        Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;

      expect(Object.keys(claims).sort()).toEqual(['exp', 'interviewId']);
      expect(claims.interviewId).toBe(interview.id);
    });
  });

  describe('audit', () => {
    it('writes no record — Table I.1 names no interview action', async () => {
      const before = await owner.auditLog.count({ where: { companyId: companyA } });
      const { interview, token } = await newOffer();
      await confirm(token, { slotId: interview.slots[0]!.id }).expect(200);

      expect(await owner.auditLog.count({ where: { companyId: companyA } })).toBe(before);
    });
  });
});
