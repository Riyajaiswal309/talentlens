import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { CalendarModule } from '../calendar/calendar.module';
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
 * FR6.1 — `GET /v1/interviewers`.
 *
 * This route widens who may read the `users` table, so the tests that matter
 * are the ones about what it REFUSES to say: nothing about another tenant,
 * nothing about Candidates, and nothing beyond identity and role. A regression
 * here leaks the user directory to every Recruiter in the product.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Interviewer picker (FR6.1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  let companyA = '';
  let companyB = '';
  let adminA = '';
  let recruiterA = '';
  let hmA = '';
  let panelHmA = '';
  let panelRecruiterA = '';
  let candidateA = '';
  let recruiterB = '';
  let panelUserB = '';

  /** Emails are prefixed so alphabetical order is predictable and asserted. */
  const emailFor = (tag: string) => `iv-${tag}.${suffix}@test.local`;

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

  const ask = (token: string, params: Record<string, string> = {}) =>
    request(app.getHttpServer()).get('/interviewers').query(params).set(auth(token));

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

    const a = await prisma.company.create({ data: { name: `Iv ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `IvB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    const mk = async (companyId: string, role: UserRole, tag: string) =>
      (
        await prisma.users.create({
          data: { companyId, role, email: emailFor(tag), passwordHash: 'x' },
        })
      ).id;

    // Tags chosen so ascending email order is 1-adm, 2-rec, 3-hm, 4-hm, 5-rec.
    adminA = await mk(companyA, UserRole.ADMIN, '1-adm');
    recruiterA = await mk(companyA, UserRole.RECRUITER, '2-rec');
    hmA = await mk(companyA, UserRole.HIRING_MANAGER, '3-hm');
    panelHmA = await mk(companyA, UserRole.HIRING_MANAGER, '4-hm');
    panelRecruiterA = await mk(companyA, UserRole.RECRUITER, '5-rec');
    candidateA = await mk(companyA, UserRole.CANDIDATE, '6-cand');

    recruiterB = await mk(companyB, UserRole.RECRUITER, 'b-1-rec');
    panelUserB = await mk(companyB, UserRole.HIRING_MANAGER, 'b-2-hm');
  });

  afterAll(async () => {
    try {
      const companies = [companyA, companyB];
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  describe('access control', () => {
    it('allows a Recruiter', async () => {
      await ask(await tokenFor(recruiterA)).expect(200);
    });

    it('allows an Administrator', async () => {
      await ask(await tokenFor(adminA)).expect(200);
    });

    it('refuses a Hiring Manager — scheduling is not theirs (D44)', async () => {
      await ask(await tokenFor(hmA)).expect(403);
    });

    it('refuses a Candidate', async () => {
      await ask(await tokenFor(candidateA)).expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(app.getHttpServer()).get('/interviewers').expect(401);
    });
  });

  describe('tenant isolation', () => {
    it('returns only users of the caller’s own company', async () => {
      const response = await ask(await tokenFor(recruiterA)).expect(200);
      const ids = response.body.data.map((u: { id: string }) => u.id);

      expect(ids).toContain(recruiterA);
      expect(ids).toContain(panelHmA);
      expect(ids).not.toContain(recruiterB);
      expect(ids).not.toContain(panelUserB);
    });

    it('never returns another tenant’s user even when that tenant is larger', async () => {
      const response = await ask(await tokenFor(recruiterB)).expect(200);
      const ids = response.body.data.map((u: { id: string }) => u.id);

      expect(ids.sort()).toEqual([recruiterB, panelUserB].sort());
    });

    it('scopes by the token’s company, not a query parameter', async () => {
      // `companyId` is not a declared query field, so `forbidNonWhitelisted`
      // rejects the attempt outright rather than silently ignoring it.
      await ask(await tokenFor(recruiterA), { companyId: companyB }).expect(400);
    });
  });

  describe('who is selectable', () => {
    it('excludes Candidates — the subject of an assessment cannot judge it', async () => {
      const response = await ask(await tokenFor(recruiterA)).expect(200);
      const ids = response.body.data.map((u: { id: string }) => u.id);

      expect(ids).not.toContain(candidateA);
    });

    it('includes Admin, Recruiter and Hiring Manager', async () => {
      const response = await ask(await tokenFor(recruiterA)).expect(200);
      const roles = new Set(response.body.data.map((u: { role: string }) => u.role));

      expect(roles).toEqual(new Set(['ADMIN', 'RECRUITER', 'HIRING_MANAGER']));
    });

    it('lists the caller themselves — a recruiter may sit on the panel', async () => {
      const response = await ask(await tokenFor(recruiterA)).expect(200);
      const ids = response.body.data.map((u: { id: string }) => u.id);

      expect(ids).toContain(recruiterA);
    });
  });

  describe('response shape', () => {
    it('returns id, email and role and nothing else', async () => {
      const response = await ask(await tokenFor(recruiterA)).expect(200);

      for (const row of response.body.data) {
        expect(Object.keys(row).sort()).toEqual(['email', 'id', 'role']);
      }
    });

    it('never exposes passwordHash, lastActiveAt or companyId', async () => {
      const response = await ask(await tokenFor(recruiterA)).expect(200);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('lastActiveAt');
      expect(serialised).not.toContain('companyId');
      // The seeded hash value itself must not appear under any key name.
      expect(
        response.body.data.every((u: Record<string, unknown>) => u.passwordHash === undefined),
      ).toBe(true);
    });

    it('orders alphabetically by email', async () => {
      const response = await ask(await tokenFor(recruiterA)).expect(200);
      const emails = response.body.data.map((u: { email: string }) => u.email);

      expect(emails).toEqual([...emails].sort());
      expect(emails).toEqual([
        emailFor('1-adm'),
        emailFor('2-rec'),
        emailFor('3-hm'),
        emailFor('4-hm'),
        emailFor('5-rec'),
      ]);
    });
  });

  describe('pagination', () => {
    it('honours limit and reports a cursor when more remain', async () => {
      const response = await ask(await tokenFor(recruiterA), { limit: '2' }).expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.nextCursor).toBe(response.body.data[1].id);
    });

    it('walks the whole tenant without repeating or skipping a user', async () => {
      const token = await tokenFor(recruiterA);
      const seen: string[] = [];
      let cursor: string | null = null;

      do {
        const params: Record<string, string> = { limit: '2' };
        if (cursor) params.cursor = cursor;
        const page = await ask(token, params).expect(200);
        seen.push(...page.body.data.map((u: { id: string }) => u.id));
        cursor = page.body.nextCursor;
      } while (cursor);

      expect(seen).toEqual([adminA, recruiterA, hmA, panelHmA, panelRecruiterA]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('returns a null cursor on the last page', async () => {
      const response = await ask(await tokenFor(recruiterA), { limit: '100' }).expect(200);

      expect(response.body.nextCursor).toBeNull();
    });

    it('refuses a limit outside 1..100', async () => {
      const token = await tokenFor(recruiterA);
      await ask(token, { limit: '0' }).expect(400);
      await ask(token, { limit: '101' }).expect(400);
    });

    it('refuses an undeclared query parameter', async () => {
      await ask(await tokenFor(recruiterA), { role: 'ADMIN' }).expect(400);
    });
  });
});
