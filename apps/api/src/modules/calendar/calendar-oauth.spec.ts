import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { CalendarConnectionStatus, CalendarProvider, UserRole } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CalendarModule } from './calendar.module';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarProviderRegistry } from './calendar-provider.registry';
import { OAuthStateStore } from './oauth-state.store';
import { GoogleCalendarAdapter } from './providers/google-calendar.adapter';
import { MicrosoftCalendarAdapter } from './providers/microsoft-calendar.adapter';
import {
  ProviderCredentialError,
  ProviderUnavailableError,
  type ProviderAdapter,
} from './providers/provider-adapter';
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
 * FR6.1 OAuth — connecting an interviewer's own calendar (D40, D43, D44).
 *
 * Both adapters are replaced with controllable fakes. Google's and
 * Microsoft's real endpoints cannot be reached without live client
 * credentials, so what is tested here is everything this repository is
 * responsible for: CSRF state, identity binding, denial handling, error
 * translation, persistence, audit and RBAC. The adapters' own wire formats are
 * covered by their unit specs and are noted as not live-verified.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

const REFRESH = 'provider-refresh-token-FROM-EXCHANGE';

/** A configurable stand-in for a real provider. */
class FakeAdapter implements ProviderAdapter {
  configured = true;
  failWith: Error | null = null;
  account = 'authorised.account@provider.example';
  lastState = '';

  isConfigured(): boolean {
    return this.configured;
  }
  authorizationUrl(state: string): string {
    this.lastState = state;
    return `https://provider.example/auth?state=${state}`;
  }
  async exchangeCode(code: string) {
    if (this.failWith) throw this.failWith;
    if (code === 'bad-code') throw new ProviderCredentialError('fake');
    return { refreshToken: REFRESH, accountIdentifier: this.account, expiresAt: null };
  }
  async accessToken() {
    return { accessToken: 'access', expiresAt: null };
  }
  async freeBusy() {
    return new Map();
  }
  async createEvent() {
    return 'event-1';
  }
  async revoke() {}
}

describe('Calendar OAuth (FR6.1, D40)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let tokens: TokenService;
  let states: OAuthStateStore;
  const google = new FakeAdapter();
  const microsoft = new FakeAdapter();

  const suffix = randomUUID().slice(0, 8);
  let companyA = '';
  let recruiterA = '';
  let hmA = '';
  let adminA = '';
  let candidateA = '';

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

  const authorize = (provider: string, token: string) =>
    request(app.getHttpServer())
      .post(`/calendar/connections/${provider}/authorize`)
      .set(auth(token));

  const complete = (provider: string, body: object, token: string) =>
    request(app.getHttpServer())
      .post(`/calendar/connections/${provider}/complete`)
      .set(auth(token))
      .send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        AuthModule,
        CalendarModule,
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
    states = moduleRef.get(OAuthStateStore);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const c = await prisma.company.create({ data: { name: `Oa ${suffix}`, dataRegion: 'test' } });
    companyA = c.id;
    const mk = async (role: UserRole, tag: string) =>
      (
        await prisma.users.create({
          data: {
            companyId: companyA,
            role,
            email: `${tag}.${suffix}@test.local`,
            passwordHash: 'x',
          },
        })
      ).id;
    recruiterA = await mk(UserRole.RECRUITER, 'oa-rec');
    hmA = await mk(UserRole.HIRING_MANAGER, 'oa-hm');
    adminA = await mk(UserRole.ADMIN, 'oa-adm');
    candidateA = await mk(UserRole.CANDIDATE, 'oa-cand');
  });

  afterAll(async () => {
    try {
      const userIds = (
        await owner.users.findMany({ where: { companyId: companyA }, select: { id: true } })
      ).map((u) => u.id);
      await owner.calendarConnection.deleteMany({ where: { userId: { in: userIds } } });
      await owner.auditLog.deleteMany({ where: { companyId: companyA } });
      await owner.company.deleteMany({ where: { id: companyA } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  beforeEach(async () => {
    google.configured = true;
    microsoft.configured = true;
    google.failWith = null;
    microsoft.failWith = null;
    google.account = 'authorised.account@provider.example';
    const userIds = [recruiterA, hmA, adminA, candidateA];
    await owner.calendarConnection.deleteMany({ where: { userId: { in: userIds } } });
  });

  describe('initiation (D40)', () => {
    it.each([['google'], ['microsoft']])('%s returns an authorization URL', async (provider) => {
      const response = await authorize(provider, await tokenFor(recruiterA)).expect(200);

      expect(response.body.authorizationUrl).toContain('https://provider.example/auth');
      expect(Object.keys(response.body)).toEqual(['authorizationUrl']);
    });

    it('carries a fresh unguessable state each time', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);
      const first = google.lastState;
      await authorize('google', token).expect(200);

      expect(first).not.toBe(google.lastState);
      // 32 random bytes, base64url.
      expect(first.length).toBeGreaterThanOrEqual(43);
    });

    it('503 when the provider is not configured on this deployment', async () => {
      google.configured = false;
      await authorize('google', await tokenFor(recruiterA)).expect(503);
    });

    it('400 for a provider outside the approved two (D35)', async () => {
      await authorize('apple', await tokenFor(recruiterA)).expect(400);
    });

    it('a Hiring Manager may connect their own (D44)', async () => {
      await authorize('google', await tokenFor(hmA)).expect(200);
    });

    it('a Candidate may not (D44)', async () => {
      await authorize('google', await tokenFor(candidateA)).expect(403);
    });

    it('an unauthenticated caller may not', async () => {
      await request(app.getHttpServer()).post('/calendar/connections/google/authorize').expect(401);
    });
  });

  describe('completion — success (D37, D43)', () => {
    it.each([['google'], ['microsoft']])('%s stores the connection', async (provider) => {
      const token = await tokenFor(recruiterA);
      await authorize(provider, token).expect(200);
      const state = provider === 'google' ? google.lastState : microsoft.lastState;

      const response = await complete(provider, { code: 'good-code', state }, token).expect(201);

      expect(response.body).toEqual({
        id: expect.any(String),
        provider,
        accountIdentifier: 'authorised.account@provider.example',
        status: CalendarConnectionStatus.connected,
      });

      const row = await owner.calendarConnection.findFirstOrThrow({
        where: { userId: recruiterA, provider: provider as CalendarProvider },
      });
      // D37 — the provider's account, not the login email.
      expect(row.accountIdentifier).toBe('authorised.account@provider.example');
      // D36 — encrypted, never the raw token.
      expect(row.encryptedRefreshToken).not.toBeNull();
      expect(row.encryptedRefreshToken).not.toContain(REFRESH);
    });

    it('never returns a credential in the response', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);
      const response = await complete(
        'google',
        { code: 'good-code', state: google.lastState },
        token,
      ).expect(201);

      const body = JSON.stringify(response.body);
      expect(body).not.toContain(REFRESH);
      for (const forbidden of ['refresh', 'access_token', 'accessToken', 'secret', 'encrypted']) {
        expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });

    it('re-connecting replaces the connection rather than duplicating it', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);
      await complete('google', { code: 'c1', state: google.lastState }, token).expect(201);

      google.account = 'moved.account@provider.example';
      await authorize('google', token).expect(200);
      await complete('google', { code: 'c2', state: google.lastState }, token).expect(201);

      const rows = await owner.calendarConnection.findMany({ where: { userId: recruiterA } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.accountIdentifier).toBe('moved.account@provider.example');
    });

    it('writes exactly one calendar.connected, with no credential in state (D43)', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);
      const before = await owner.auditLog.count({
        where: { action: 'calendar.connected', companyId: companyA },
      });

      const response = await complete(
        'google',
        { code: 'good-code', state: google.lastState },
        token,
      ).expect(201);

      expect(
        (await owner.auditLog.count({
          where: { action: 'calendar.connected', companyId: companyA },
        })) - before,
      ).toBe(1);

      const record = await owner.auditLog.findFirstOrThrow({
        where: { action: 'calendar.connected', resourceId: response.body.id },
      });
      expect(record.resourceType).toBe('calendar_connection');
      expect(record.actorType).toBe('USER');
      expect(record.actorId).toBe(recruiterA);
      expect(record.afterState).toEqual({
        provider: 'google',
        accountIdentifier: 'authorised.account@provider.example',
      });

      const serialised = JSON.stringify(record).toLowerCase();
      expect(serialised).not.toContain(REFRESH.toLowerCase());
      for (const f of ['refresh_token', 'access_token', 'authorization_code', 'client_secret']) {
        expect(serialised).not.toContain(f);
      }
    });
  });

  describe('state validation (B)', () => {
    it('401 for an unknown state', async () => {
      await complete(
        'google',
        { code: 'c', state: 'never-issued' },
        await tokenFor(recruiterA),
      ).expect(401);
    });

    it('401 when the same state is replayed', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);
      const state = google.lastState;

      await complete('google', { code: 'c1', state }, token).expect(201);
      // Single use: the second attempt finds nothing.
      await complete('google', { code: 'c2', state }, token).expect(401);
    });

    it('403 when another user tries to complete someone else’s authorisation', async () => {
      await authorize('google', await tokenFor(recruiterA)).expect(200);
      const stolen = google.lastState;

      // The cross-account attack the state exists to stop.
      await complete('google', { code: 'c', state: stolen }, await tokenFor(hmA)).expect(403);

      expect(await owner.calendarConnection.count({ where: { userId: hmA } })).toBe(0);
    });

    it('400 when the state was issued for a different provider', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);

      await complete('microsoft', { code: 'c', state: google.lastState }, token).expect(400);
    });

    it('400 when state is missing entirely', async () => {
      await complete('google', { code: 'c' }, await tokenFor(recruiterA)).expect(400);
    });

    it('a consumed state cannot be reused even by its owner', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);
      const state = google.lastState;
      expect(await states.consume(state)).not.toBeNull();
      expect(await states.consume(state)).toBeNull();
    });
  });

  describe('denial and provider failure', () => {
    it('400 and stores nothing when the user denies consent', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);

      const response = await complete(
        'google',
        { state: google.lastState, error: 'access_denied' },
        token,
      ).expect(400);

      expect(response.body.detail).toMatch(/not granted/i);
      expect(await owner.calendarConnection.count({ where: { userId: recruiterA } })).toBe(0);
    });

    it('400 when the provider rejects the code, without echoing it', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);

      const response = await complete(
        'google',
        { code: 'bad-code', state: google.lastState },
        token,
      ).expect(400);

      expect(JSON.stringify(response.body)).not.toContain('bad-code');
      expect(await owner.calendarConnection.count({ where: { userId: recruiterA } })).toBe(0);
    });

    it('503 when the provider does not respond', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);
      google.failWith = new ProviderUnavailableError('google');

      await complete('google', { code: 'c', state: google.lastState }, token).expect(503);
      expect(await owner.calendarConnection.count({ where: { userId: recruiterA } })).toBe(0);
    });

    it('writes no calendar.connected when the exchange fails', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);
      const before = await owner.auditLog.count({
        where: { action: 'calendar.connected', companyId: companyA },
      });

      await complete('google', { code: 'bad-code', state: google.lastState }, token).expect(400);

      expect(
        await owner.auditLog.count({
          where: { action: 'calendar.connected', companyId: companyA },
        }),
      ).toBe(before);
    });
  });

  describe('no route accepts a client-supplied credential', () => {
    it('rejects a body carrying a refresh token (forbidNonWhitelisted)', async () => {
      const token = await tokenFor(recruiterA);
      await authorize('google', token).expect(200);

      await complete(
        'google',
        { code: 'c', state: google.lastState, refreshToken: 'attacker-token' },
        token,
      ).expect(400);
    });

    it('no request DTO carries a credential field', () => {
      /*
       * `authorise()` takes a refresh token, and that is safe only because the
       * value always comes from the provider exchange and never from a
       * request. Two things are pinned:
       *
       *   1. the completion DTO declares no token-shaped property, and
       *   2. no controller reads one off `dto`.
       *
       * The controller legitimately writes `refreshToken: account.refreshToken`
       * — that is the value the adapter just obtained — so a naive scan for the
       * word would flag correct code. These assertions target the direction
       * that matters: request → storage.
       */
      const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
      const dto = read('dto/complete-connection.dto.ts');
      const controllers = [
        read('calendar-oauth.controller.ts'),
        read('calendar-connections.controller.ts'),
      ].join('\n');

      // The DTO's only fields are state, code and error.
      expect(dto).not.toMatch(/refreshToken|accessToken|token\s*[!?]?\s*:/);
      // And nothing reads a credential from the request object.
      expect(controllers).not.toMatch(/dto\.(refreshToken|accessToken)/);
      expect(controllers).not.toMatch(/body\.(refreshToken|accessToken)/);
    });
  });

  describe('registry reflects configuration', () => {
    it('reports only configured providers', () => {
      const registry = app.get(CalendarProviderRegistry);
      expect(registry.anyConfigured()).toBe(true);

      google.configured = false;
      microsoft.configured = false;
      expect(registry.anyConfigured()).toBe(false);
      expect(registry.configured()).toEqual([]);
    });
  });

  describe('service seam', () => {
    it('authorise() seals the refresh token before it reaches the database', async () => {
      const connections = app.get(CalendarConnectionsService);
      const created = await connections.authorise({
        userId: adminA,
        provider: CalendarProvider.google,
        accountIdentifier: 'direct@provider.example',
        refreshToken: REFRESH,
      });

      const row = await owner.calendarConnection.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.encryptedRefreshToken).not.toBe(REFRESH);
      expect(await connections.resolveRefreshToken(adminA, CalendarProvider.google)).toBe(REFRESH);
    });
  });
});
