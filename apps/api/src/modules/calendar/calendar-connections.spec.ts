import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { CalendarConnectionStatus, CalendarProvider, UserRole } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { CalendarModule } from './calendar.module';
import { isKnownAction } from '../audit/audit-actions';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarCredentialCipher } from './calendar-credential.cipher';
import { AdminModule } from '../admin/admin.module';
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
import type { NextFunction, Response } from 'express';
import type { RequestContext } from '../../common/types/authenticated-request';

/**
 * FR6.1 Phase 1 — the calendar connection foundation (D34–D45).
 *
 * The security properties are the point of this file: a credential never
 * leaves the boundary, ownership is per-interviewer, and offboarding takes the
 * connection with it. There is no connect endpoint to exercise — that waits on
 * a provider adapter — so connections are created through the service seam a
 * real adapter will use.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Calendar connections (FR6.1 Phase 1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let connections: CalendarConnectionsService;
  let cipher: CalendarCredentialCipher;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  const REFRESH = 'provider-refresh-token-SECRET-VALUE';

  let companyA = '';
  let companyB = '';
  let adminA = '';
  let recruiterA = '';
  let hmA = '';
  let candidateA = '';
  let adminB = '';
  let recruiterB = '';

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

  const connect = (userId: string, provider: CalendarProvider = CalendarProvider.google) =>
    connections.authorise({
      userId,
      provider,
      accountIdentifier: `calendar.${userId.slice(0, 8)}@provider.example`,
      refreshToken: REFRESH,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        AuthModule,
        CalendarModule,
        AdminModule,
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
    connections = moduleRef.get(CalendarConnectionsService);
    cipher = moduleRef.get(CalendarCredentialCipher);
    tokens = moduleRef.get(TokenService);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `CalA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `CalB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
      });
      return user.id;
    }

    adminA = await makeUser(companyA, UserRole.ADMIN, 'cal-adm-a');
    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'cal-rec-a');
    hmA = await makeUser(companyA, UserRole.HIRING_MANAGER, 'cal-hm-a');
    candidateA = await makeUser(companyA, UserRole.CANDIDATE, 'cal-cand-a');
    adminB = await makeUser(companyB, UserRole.ADMIN, 'cal-adm-b');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'cal-rec-b');
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
    const userIds = [adminA, recruiterA, hmA, candidateA, adminB, recruiterB];
    await owner.calendarConnection.deleteMany({ where: { userId: { in: userIds } } });
  });

  describe('storage (D34, D36, D37)', () => {
    it('stores the refresh token encrypted, never in plaintext', async () => {
      const connection = await connect(recruiterA);

      const row = await owner.calendarConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });

      expect(row.encryptedRefreshToken).not.toBeNull();
      expect(row.encryptedRefreshToken).not.toBe(REFRESH);
      expect(row.encryptedRefreshToken).not.toContain(REFRESH);
      // And it is genuinely the same secret, sealed.
      expect(cipher.open(row.encryptedRefreshToken!)).toBe(REFRESH);
    });

    it('has no column that could hold an access token', async () => {
      const columns = await owner.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'calendar_connections'`,
      );
      const names = columns.map((c) => c.column_name).sort();

      expect(names).toEqual([
        'account_identifier',
        'created_at',
        'disconnected_at',
        'encrypted_refresh_token',
        'expires_at',
        'id',
        'provider',
        'status',
        'updated_at',
        'user_id',
      ]);
      // D36 — access tokens are runtime-only. There is nowhere to persist one.
      expect(names).not.toContain('access_token');
    });

    it('captures account_identifier explicitly rather than the login email (D37)', async () => {
      const connection = await connect(recruiterA);
      const user = await owner.users.findUniqueOrThrow({ where: { id: recruiterA } });

      expect(connection.accountIdentifier).toBeTruthy();
      expect(connection.accountIdentifier).not.toBe(user.email);
    });

    it('replaces rather than duplicates when the same provider is re-authorised', async () => {
      const first = await connect(recruiterA);
      const second = await connections.authorise({
        userId: recruiterA,
        provider: CalendarProvider.google,
        accountIdentifier: 'moved@provider.example',
        refreshToken: 'a-new-refresh-token',
      });

      expect(second.id).toBe(first.id);
      expect(second.accountIdentifier).toBe('moved@provider.example');
      expect(await owner.calendarConnection.count({ where: { userId: recruiterA } })).toBe(1);
    });

    it('allows one connection per provider for the same user (D35)', async () => {
      await connect(recruiterA, CalendarProvider.google);
      await connect(recruiterA, CalendarProvider.microsoft);

      expect(await owner.calendarConnection.count({ where: { userId: recruiterA } })).toBe(2);
    });

    it('re-authorising after a disconnect returns the row to connected', async () => {
      const created = await connect(recruiterA);
      await connections.disconnectAllForUser(recruiterA);
      const revived = await connect(recruiterA);

      expect(revived.id).toBe(created.id);
      expect(revived.status).toBe(CalendarConnectionStatus.connected);
      expect(revived.disconnectedAt).toBeNull();
    });
  });

  /*
   * FR6.1 — the honest "is this deployment even wired up?" read.
   *
   * This spec uses the REAL adapters, so `configured` here reflects whatever
   * credentials the environment actually holds. With none present — the state
   * this build ships in — both providers report false, which is precisely what
   * the Calendar Connections screen renders as "not configured on this server".
   */
  describe('provider configuration status', () => {
    /** Resolves the token first so the supertest chain stays chainable. */
    const askProviders = (userId: string, status: number) =>
      tokenFor(userId).then((token) =>
        request(app.getHttpServer())
          .get('/calendar/connections/providers')
          .set(auth(token))
          .expect(status),
      );

    it('lists every known provider with a configured flag', async () => {
      const response = await askProviders(recruiterA, 200);
      const byProvider = Object.fromEntries(
        response.body.data.map((p: { provider: string; configured: boolean }) => [
          p.provider,
          p.configured,
        ]),
      );

      expect(Object.keys(byProvider).sort()).toEqual(['google', 'microsoft']);
      expect(typeof byProvider.google).toBe('boolean');
      expect(typeof byProvider.microsoft).toBe('boolean');
    });

    it('exposes ONLY provider and configured — never a client id or secret', async () => {
      const response = await askProviders(recruiterA, 200);

      for (const entry of response.body.data) {
        expect(Object.keys(entry).sort()).toEqual(['configured', 'provider']);
      }
      // Belt and braces: no credential-shaped value anywhere in the payload.
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toMatch(/secret|client_id|clientId|redirect/i);
    });

    it('agrees with authorize: an unconfigured provider answers 503 there', async () => {
      const response = await askProviders(recruiterA, 200);
      const google = response.body.data.find((p: { provider: string }) => p.provider === 'google');

      const authorize = await request(app.getHttpServer())
        .post('/calendar/connections/google/authorize')
        .set(auth(await tokenFor(recruiterA)));

      // The two reads must never disagree — that inconsistency is exactly what
      // would put a dead Connect button in front of a user.
      expect(authorize.status).toBe(google.configured ? 200 : 503);
    });

    it('is readable by Recruiter, Hiring Manager and Admin', async () => {
      await askProviders(recruiterA, 200);
      await askProviders(hmA, 200);
      await askProviders(adminA, 200);
    });

    it('refuses a Candidate (D44)', async () => {
      await askProviders(candidateA, 403);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(app.getHttpServer()).get('/calendar/connections/providers').expect(401);
    });
  });

  describe('reading own connections', () => {
    it('returns safe metadata only — never a credential (D36, D45)', async () => {
      await connect(recruiterA);

      const response = await request(app.getHttpServer())
        .get('/calendar/connections')
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const [entry] = response.body.data;
      expect(Object.keys(entry).sort()).toEqual([
        'accountIdentifier',
        'createdAt',
        'disconnectedAt',
        'expiresAt',
        'id',
        'provider',
        'status',
        'updatedAt',
      ]);

      // Nothing credential-shaped anywhere in the payload.
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(REFRESH);
      for (const forbidden of ['refreshToken', 'accessToken', 'encrypted', 'token', 'secret']) {
        expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });

    it('shows only the caller’s own connections', async () => {
      await connect(recruiterA);
      await connect(hmA);

      const response = await request(app.getHttpServer())
        .get('/calendar/connections')
        .set(auth(await tokenFor(hmA)))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].accountIdentifier).toContain(hmA.slice(0, 8));
    });

    it('a Candidate cannot read calendar connections (D44)', async () => {
      await request(app.getHttpServer())
        .get('/calendar/connections')
        .set(auth(await tokenFor(candidateA)))
        .expect(403);
    });
  });

  describe('disconnecting one’s own calendar (D44)', () => {
    it('a Recruiter disconnects their own', async () => {
      await connect(recruiterA);

      const response = await request(app.getHttpServer())
        .delete('/calendar/connections/google')
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(response.body.status).toBe(CalendarConnectionStatus.disconnected);

      const row = await owner.calendarConnection.findFirstOrThrow({
        where: { userId: recruiterA },
      });
      expect(row.status).toBe(CalendarConnectionStatus.disconnected);
      // The credential is cleared, not merely flagged.
      expect(row.encryptedRefreshToken).toBeNull();
      expect(row.disconnectedAt).not.toBeNull();
    });

    it('a Hiring Manager may disconnect their own — they are interviewers (D44)', async () => {
      await connect(hmA);

      await request(app.getHttpServer())
        .delete('/calendar/connections/google')
        .set(auth(await tokenFor(hmA)))
        .expect(200);
    });

    it('a Candidate cannot disconnect (D44)', async () => {
      await request(app.getHttpServer())
        .delete('/calendar/connections/google')
        .set(auth(await tokenFor(candidateA)))
        .expect(403);
    });

    it('404 when the caller has no connection for that provider', async () => {
      await request(app.getHttpServer())
        .delete('/calendar/connections/microsoft')
        .set(auth(await tokenFor(recruiterA)))
        .expect(404);
    });

    it('400 for a provider outside the approved two (D35)', async () => {
      await request(app.getHttpServer())
        .delete('/calendar/connections/apple')
        .set(auth(await tokenFor(recruiterA)))
        .expect(400);
    });

    it('an unauthenticated caller cannot disconnect', async () => {
      await request(app.getHttpServer()).delete('/calendar/connections/google').expect(401);
    });
  });

  describe('Administrator disconnecting another user (D44)', () => {
    it('an Admin disconnects a colleague’s calendar', async () => {
      await connect(recruiterA);

      await request(app.getHttpServer())
        .delete(`/calendar/connections/users/${recruiterA}/google`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const row = await owner.calendarConnection.findFirstOrThrow({
        where: { userId: recruiterA },
      });
      expect(row.status).toBe(CalendarConnectionStatus.disconnected);
      expect(row.encryptedRefreshToken).toBeNull();
    });

    it('a Recruiter cannot disconnect another user’s calendar', async () => {
      await connect(hmA);

      await request(app.getHttpServer())
        .delete(`/calendar/connections/users/${hmA}/google`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(403);

      const row = await owner.calendarConnection.findFirstOrThrow({ where: { userId: hmA } });
      expect(row.status).toBe(CalendarConnectionStatus.connected);
    });

    it('a cross-tenant Admin gets 404, not 403 (BR-06)', async () => {
      await connect(recruiterA);

      await request(app.getHttpServer())
        .delete(`/calendar/connections/users/${recruiterA}/google`)
        .set(auth(await tokenFor(adminB)))
        .expect(404);

      // And the foreign connection is untouched.
      const row = await owner.calendarConnection.findFirstOrThrow({
        where: { userId: recruiterA },
      });
      expect(row.status).toBe(CalendarConnectionStatus.connected);
      expect(row.encryptedRefreshToken).not.toBeNull();
    });

    it('a foreign user is refused identically to one with no connection', async () => {
      const token = await tokenFor(adminB);
      await connect(recruiterA);

      const foreign = await request(app.getHttpServer())
        .delete(`/calendar/connections/users/${recruiterA}/google`)
        .set(auth(token));
      const absent = await request(app.getHttpServer())
        .delete(`/calendar/connections/users/${recruiterB}/google`)
        .set(auth(token));

      const strip = (body: Record<string, unknown>) => {
        const { correlationId: _c, instance: _i, ...rest } = body;
        return rest;
      };
      expect(foreign.status).toBe(absent.status);
      expect(strip(foreign.body)).toEqual(strip(absent.body));
    });
  });

  describe('audit (D43, C4)', () => {
    it('writes exactly one calendar.disconnected, carrying no credential', async () => {
      const connection = await connect(recruiterA);
      const before = await owner.auditLog.count({
        where: { action: 'calendar.disconnected', companyId: companyA },
      });

      await request(app.getHttpServer())
        .delete('/calendar/connections/google')
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const after = await owner.auditLog.count({
        where: { action: 'calendar.disconnected', companyId: companyA },
      });
      expect(after - before).toBe(1);

      const record = await owner.auditLog.findFirstOrThrow({
        where: { action: 'calendar.disconnected', resourceId: connection.id },
        orderBy: { createdAt: 'desc' },
      });

      expect(record.resourceType).toBe('calendar_connection');
      expect(record.actorType).toBe('USER');
      expect(record.actorId).toBe(recruiterA);
      expect(record.companyId).toBe(companyA);
      expect(record.beforeState).toEqual({
        provider: CalendarProvider.google,
        accountIdentifier: connection.accountIdentifier,
      });

      // No credential material of any kind reached the audit log.
      const serialised = JSON.stringify(record).toLowerCase();
      expect(serialised).not.toContain(REFRESH.toLowerCase());
      for (const forbidden of [
        'refreshtoken',
        'accesstoken',
        'ciphertext',
        'encrypted',
        'secret',
      ]) {
        expect(serialised).not.toContain(forbidden);
      }
    });

    it('records the acting administrator as the actor when they disconnect', async () => {
      const connection = await connect(recruiterA);

      await request(app.getHttpServer())
        .delete(`/calendar/connections/users/${recruiterA}/google`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const record = await owner.auditLog.findFirstOrThrow({
        where: { action: 'calendar.disconnected', resourceId: connection.id },
        orderBy: { createdAt: 'desc' },
      });

      expect(record.actorId).toBe(adminA);
    });

    it('emits nothing when the disconnect is refused', async () => {
      const before = await owner.auditLog.count({
        where: { action: 'calendar.disconnected', companyId: companyA },
      });

      await request(app.getHttpServer())
        .delete('/calendar/connections/google')
        .set(auth(await tokenFor(recruiterA)))
        .expect(404);

      expect(
        await owner.auditLog.count({
          where: { action: 'calendar.disconnected', companyId: companyA },
        }),
      ).toBe(before);
    });

    it('both calendar actions are in the declared vocabulary', () => {
      /*
       * Gap 4 rule 2 rejects an unlisted actionType with 400, so an action the
       * system emits but does not declare would be unfilterable. The reverse —
       * declaring more than is emitted — is allowed, which is why
       * `calendar.connected` is listed although only the unbuilt provider
       * adapter will ever write it.
       *
       * Asserted against the vocabulary directly rather than through
       * /audit-logs: the browser's own filtering is already covered by
       * audit.spec.ts, and duplicating it here would only test AuditModule.
       */
      expect(isKnownAction('calendar.connected')).toBe(true);
      expect(isKnownAction('calendar.disconnected')).toBe(true);
    });
  });

  describe('FR8.4 session revocation removes the connection (D45)', () => {
    it('revoking sessions disconnects every calendar the user held', async () => {
      await connect(recruiterA, CalendarProvider.google);
      await connect(recruiterA, CalendarProvider.microsoft);

      await request(app.getHttpServer())
        .delete(`/admin/users/${recruiterA}/sessions`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const rows = await owner.calendarConnection.findMany({ where: { userId: recruiterA } });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe(CalendarConnectionStatus.disconnected);
        // AD-06 exists for immediate offboarding: the credential must be gone,
        // not merely flagged.
        expect(row.encryptedRefreshToken).toBeNull();
      }
    });

    it('writes one calendar.disconnected per connection, with the admin as actor', async () => {
      await connect(recruiterA, CalendarProvider.google);
      await connect(recruiterA, CalendarProvider.microsoft);

      const before = await owner.auditLog.count({
        where: { action: 'calendar.disconnected', companyId: companyA },
      });

      await request(app.getHttpServer())
        .delete(`/admin/users/${recruiterA}/sessions`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const records = await owner.auditLog.findMany({
        where: { action: 'calendar.disconnected', companyId: companyA },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });

      expect(
        (await owner.auditLog.count({
          where: { action: 'calendar.disconnected', companyId: companyA },
        })) - before,
      ).toBe(2);
      for (const record of records) {
        expect(record.actorId).toBe(adminA);
        expect(record.resourceType).toBe('calendar_connection');
      }
    });

    it('writes no calendar record when the user held no connection', async () => {
      const before = await owner.auditLog.count({
        where: { action: 'calendar.disconnected', companyId: companyA },
      });

      await request(app.getHttpServer())
        .delete(`/admin/users/${hmA}/sessions`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(
        await owner.auditLog.count({
          where: { action: 'calendar.disconnected', companyId: companyA },
        }),
      ).toBe(before);
    });

    it('still revokes sessions — existing FR8.4 behaviour is unchanged', async () => {
      const response = await request(app.getHttpServer())
        .delete(`/admin/users/${recruiterA}/sessions`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.body).toHaveProperty('revokedCount');
      expect(response.body).toHaveProperty('revokedAt');
      // The FR8.4 response shape must not have grown calendar fields.
      expect(Object.keys(response.body).sort()).toEqual(['revokedAt', 'revokedCount']);
    });
  });

  describe('credential resolution is the only path to plaintext', () => {
    it('returns the token for a connected calendar', async () => {
      await connect(recruiterA);

      expect(await connections.resolveRefreshToken(recruiterA, CalendarProvider.google)).toBe(
        REFRESH,
      );
    });

    it('returns null once disconnected', async () => {
      await connect(recruiterA);
      await connections.disconnectAllForUser(recruiterA);

      expect(await connections.resolveRefreshToken(recruiterA, CalendarProvider.google)).toBeNull();
    });

    it('disconnects rather than retrying when the stored value will not open (D36)', async () => {
      const connection = await connect(recruiterA);

      // Simulate a credential sealed under a key this deployment no longer has.
      await owner.calendarConnection.update({
        where: { id: connection.id },
        data: { encryptedRefreshToken: 'not.valid.ciphertext' },
      });

      expect(await connections.resolveRefreshToken(recruiterA, CalendarProvider.google)).toBeNull();

      const row = await owner.calendarConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.status).toBe(CalendarConnectionStatus.disconnected);
      expect(row.encryptedRefreshToken).toBeNull();
    });
  });
});
