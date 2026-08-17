import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { CalendarProvider as Provider, UserRole } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { CalendarModule } from '../calendar/calendar.module';
import { CalendarConnectionsService } from '../calendar/calendar-connections.service';
import { GoogleCalendarAdapter } from '../calendar/providers/google-calendar.adapter';
import { MicrosoftCalendarAdapter } from '../calendar/providers/microsoft-calendar.adapter';
import {
  ProviderUnavailableError,
  type ProviderAdapter,
} from '../calendar/providers/provider-adapter';
import { InterviewsModule } from './interviews.module';
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
import type { NextFunction, Response } from 'express';
import type { RequestContext } from '../../common/types/authenticated-request';

/**
 * FR6.1 — `GET /v1/interviews/availability` (D42, B8).
 *
 * The distinctions this endpoint exists to make, and which nothing else
 * enforces: an unconnected interviewer is reported, not an error; a configured
 * provider that fails is a 503; and no provider configured at all is still a
 * 200 with everyone unconnected, because that is manual-scheduling mode.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

const FROM = '2026-09-01T09:00:00.000Z';
const TO = '2026-09-01T17:00:00.000Z';

class FakeAdapter implements ProviderAdapter {
  configured = true;
  outage = false;
  busy = new Map<string, { startsAt: Date; endsAt: Date }[]>();

  isConfigured(): boolean {
    return this.configured;
  }
  authorizationUrl(): string {
    return 'https://provider.example/auth';
  }
  async exchangeCode() {
    return { refreshToken: 'r', accountIdentifier: 'a@provider.example', expiresAt: null };
  }
  async accessToken() {
    if (this.outage) throw new ProviderUnavailableError('fake');
    return { accessToken: 'access', expiresAt: null };
  }
  async freeBusy() {
    if (this.outage) throw new ProviderUnavailableError('fake');
    return this.busy;
  }
  async createEvent() {
    return 'event-1';
  }
  async revoke() {}
}

describe('Interviewer availability (FR6.1, D42)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let tokens: TokenService;
  let connections: CalendarConnectionsService;
  const google = new FakeAdapter();
  const microsoft = new FakeAdapter();

  const suffix = randomUUID().slice(0, 8);
  let companyA = '';
  let companyB = '';
  let recruiterA = '';
  let adminA = '';
  let hmA = '';
  let candidateA = '';
  let interviewer1 = '';
  let interviewer2 = '';
  let foreignUser = '';

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

  const ask = (token: string, params: Record<string, string>) =>
    request(app.getHttpServer()).get('/interviews/availability').query(params).set(auth(token));

  const connect = (userId: string, account: string, provider: Provider = Provider.google) =>
    connections.authorise({
      userId,
      provider,
      accountIdentifier: account,
      refreshToken: 'stored-refresh',
    });

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
    })
      .overrideProvider(GoogleCalendarAdapter)
      .useValue(google)
      .overrideProvider(MicrosoftCalendarAdapter)
      .useValue(microsoft)
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
    tokens = moduleRef.get(TokenService);
    connections = moduleRef.get(CalendarConnectionsService);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `Av ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `AvB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    const mk = async (companyId: string, role: UserRole, tag: string) =>
      (
        await prisma.users.create({
          data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
        })
      ).id;

    recruiterA = await mk(companyA, UserRole.RECRUITER, 'av-rec');
    adminA = await mk(companyA, UserRole.ADMIN, 'av-adm');
    hmA = await mk(companyA, UserRole.HIRING_MANAGER, 'av-hm');
    candidateA = await mk(companyA, UserRole.CANDIDATE, 'av-cand');
    interviewer1 = await mk(companyA, UserRole.HIRING_MANAGER, 'av-int1');
    interviewer2 = await mk(companyA, UserRole.RECRUITER, 'av-int2');
    foreignUser = await mk(companyB, UserRole.RECRUITER, 'av-foreign');
  });

  afterAll(async () => {
    try {
      const companies = [companyA, companyB];
      const userIds = (
        await owner.users.findMany({
          where: { companyId: { in: companies } },
          select: { id: true },
        })
      ).map((u) => u.id);
      await owner.calendarConnection.deleteMany({ where: { userId: { in: userIds } } });
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  beforeEach(async () => {
    google.configured = true;
    microsoft.configured = true;
    google.outage = false;
    microsoft.outage = false;
    google.busy = new Map();
    const userIds = [recruiterA, adminA, hmA, candidateA, interviewer1, interviewer2, foreignUser];
    await owner.calendarConnection.deleteMany({ where: { userId: { in: userIds } } });
  });

  describe('success', () => {
    it('returns busy blocks for a connected interviewer', async () => {
      await connect(interviewer1, 'one@provider.example');
      google.busy = new Map([
        ['one@provider.example', [{ startsAt: new Date(FROM), endsAt: new Date(TO) }]],
      ]);

      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(200);

      expect(response.body.availability).toEqual([
        { email: 'one@provider.example', busy: [{ startsAt: FROM, endsAt: TO }] },
      ]);
      expect(response.body.notConnected).toEqual([]);
      expect(response.body.from).toBe(FROM);
      expect(response.body.to).toBe(TO);
    });

    it('handles multiple interviewers across both providers', async () => {
      await connect(interviewer1, 'one@provider.example', Provider.google);
      await connect(interviewer2, 'two@provider.example', Provider.microsoft);
      google.busy = new Map([['one@provider.example', []]]);
      microsoft.busy = new Map([['two@provider.example', []]]);

      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: `${interviewer1},${interviewer2}`,
        from: FROM,
        to: TO,
      }).expect(200);

      expect(response.body.availability).toHaveLength(2);
      expect(response.body.notConnected).toEqual([]);
      // D35 — nothing tells the caller which provider answered.
      expect(JSON.stringify(response.body).toLowerCase()).not.toContain('google');
      expect(JSON.stringify(response.body).toLowerCase()).not.toContain('microsoft');
    });

    it('reports a connected interviewer with nothing booked as an empty busy list', async () => {
      await connect(interviewer1, 'free@provider.example');
      google.busy = new Map();

      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(200);

      expect(response.body.availability).toEqual([{ email: 'free@provider.example', busy: [] }]);
      expect(response.body.notConnected).toEqual([]);
    });

    it('exposes only intervals — no titles, attendees, locations or descriptions', async () => {
      await connect(interviewer1, 'one@provider.example');
      google.busy = new Map([
        ['one@provider.example', [{ startsAt: new Date(FROM), endsAt: new Date(TO) }]],
      ]);

      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(200);

      const entry = response.body.availability[0];
      expect(Object.keys(entry).sort()).toEqual(['busy', 'email']);
      expect(Object.keys(entry.busy[0]).sort()).toEqual(['endsAt', 'startsAt']);
    });
  });

  describe('notConnected is a state, not a failure (D42)', () => {
    it('lists an interviewer with no calendar', async () => {
      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(200);

      expect(response.body.availability).toEqual([]);
      expect(response.body.notConnected).toEqual([interviewer1]);
    });

    it('mixes connected and unconnected in one answer', async () => {
      await connect(interviewer1, 'one@provider.example');
      google.busy = new Map([['one@provider.example', []]]);

      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: `${interviewer1},${interviewer2}`,
        from: FROM,
        to: TO,
      }).expect(200);

      expect(response.body.availability).toHaveLength(1);
      expect(response.body.notConnected).toEqual([interviewer2]);
    });

    it('lists a disconnected interviewer as notConnected, not as an error', async () => {
      await connect(interviewer1, 'one@provider.example');
      await connections.disconnectAllForUser(interviewer1);

      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(200);

      expect(response.body.notConnected).toEqual([interviewer1]);
    });

    it('is still 200 when NO provider is configured — manual mode (FR6.3)', async () => {
      google.configured = false;
      microsoft.configured = false;
      await connect(interviewer1, 'one@provider.example');

      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(200);

      // An unconfigured deployment is not an outage: the recruiter's next step
      // is to book manually, not to treat the system as broken.
      expect(response.body.availability).toEqual([]);
      expect(response.body.notConnected).toEqual([interviewer1]);
    });
  });

  describe('503 is only for a configured provider that fails', () => {
    it('returns 503 when the provider does not answer', async () => {
      await connect(interviewer1, 'one@provider.example');
      google.outage = true;

      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(503);

      expect(response.body.detail).toMatch(/unavailable/i);
      // Standard ProblemDetails, per §23.1.
      expect(response.body).toMatchObject({ type: 'about:blank', status: 503 });
    });

    it('does NOT return 503 merely because nobody is connected', async () => {
      google.outage = true; // would fail if it were called at all
      await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(200);
    });
  });

  describe('validation (D42)', () => {
    it('400 when from is after to', async () => {
      await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: TO,
        to: FROM,
      }).expect(400);
    });

    it('400 for a malformed date', async () => {
      await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: 'yesterday',
        to: TO,
      }).expect(400);
    });

    it('400 for a non-uuid interviewer id', async () => {
      await ask(await tokenFor(recruiterA), {
        interviewerIds: 'not-a-uuid',
        from: FROM,
        to: TO,
      }).expect(400);
    });

    it('400 when interviewerIds is missing', async () => {
      await ask(await tokenFor(recruiterA), { from: FROM, to: TO }).expect(400);
    });

    it('400 for an unrecognised parameter, including a cursor (D42)', async () => {
      await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
        cursor: 'abc',
      }).expect(400);
    });
  });

  describe('RBAC (D42 — Recruiter and Admin)', () => {
    it('an Administrator may read availability', async () => {
      await ask(await tokenFor(adminA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(200);
    });

    it('a Hiring Manager may not', async () => {
      await ask(await tokenFor(hmA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(403);
    });

    it('a Candidate may not', async () => {
      await ask(await tokenFor(candidateA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(403);
    });

    it('an unauthenticated caller may not', async () => {
      await request(app.getHttpServer())
        .get('/interviews/availability')
        .query({ interviewerIds: interviewer1, from: FROM, to: TO })
        .expect(401);
    });
  });

  describe('tenant isolation', () => {
    it('never reads a user outside the caller’s tenant', async () => {
      await connect(foreignUser, 'foreign@provider.example');
      google.busy = new Map([
        ['foreign@provider.example', [{ startsAt: new Date(FROM), endsAt: new Date(TO) }]],
      ]);

      const response = await ask(await tokenFor(recruiterA), {
        interviewerIds: foreignUser,
        from: FROM,
        to: TO,
      }).expect(200);

      /*
       * The foreign user's calendar is never queried, and they come back as
       * notConnected — indistinguishable from a colleague who simply has not
       * linked one. That is BR-06's non-disclosure applied to a bulk read: a
       * 404 would confirm the id exists somewhere, a 403 would be worse.
       */
      expect(response.body.availability).toEqual([]);
      expect(response.body.notConnected).toEqual([foreignUser]);
      expect(JSON.stringify(response.body)).not.toContain('foreign@provider.example');
    });

    it('a nonexistent id is reported identically to a foreign one', async () => {
      const token = await tokenFor(recruiterA);
      const absent = randomUUID();

      const a = await ask(token, { interviewerIds: foreignUser, from: FROM, to: TO }).expect(200);
      const b = await ask(token, { interviewerIds: absent, from: FROM, to: TO }).expect(200);

      expect(a.body.availability).toEqual(b.body.availability);
      expect(a.body.notConnected).toEqual([foreignUser]);
      expect(b.body.notConnected).toEqual([absent]);
    });
  });

  describe('audit', () => {
    it('writes no record — reading availability changes no state', async () => {
      const before = await owner.auditLog.count({ where: { companyId: companyA } });

      await ask(await tokenFor(recruiterA), {
        interviewerIds: interviewer1,
        from: FROM,
        to: TO,
      }).expect(200);

      expect(await owner.auditLog.count({ where: { companyId: companyA } })).toBe(before);
    });
  });
});
