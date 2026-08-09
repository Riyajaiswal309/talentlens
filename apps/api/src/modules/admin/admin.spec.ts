import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AdminModule } from './admin.module';
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
import { RefreshTokenStore } from '../auth/refresh-token.store';
import { TokenService } from '../auth/token.service';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * M2.10 AdminModule — FR8.1, FR8.2, FR8.4 (Handoff §B rows 20–24).
 *
 * Real guard chain and real tokens throughout: every route here is
 * Administrator-only, and "Administrator-only" is only true if the chain
 * enforces it.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('AdminModule (FR8.1, FR8.2, FR8.4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let jobs: JobsService;
  let tokens: TokenService;
  let sessions: RefreshTokenStore;

  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  let companyA = '';
  let companyB = '';
  let adminA = '';
  let adminA2 = '';
  let recruiterA = '';
  let hmA = '';
  let adminB = '';
  let soleAdminCompany = '';
  let soleAdmin = '';
  let jobA = '';
  let jobB = '';

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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        AuthModule,
        JobsModule,
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
    jobs = moduleRef.get(JobsService);
    tokens = moduleRef.get(TokenService);
    sessions = moduleRef.get(RefreshTokenStore);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `AdmA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `AdmB ${suffix}`, dataRegion: 'test' } });
    const sole = await prisma.company.create({
      data: { name: `AdmSole ${suffix}`, dataRegion: 'test' },
    });
    companyA = a.id;
    companyB = b.id;
    soleAdminCompany = sole.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
      });
      userIds.push(user.id);
      return user.id;
    }

    adminA = await makeUser(companyA, UserRole.ADMIN, 'adm-a1');
    adminA2 = await makeUser(companyA, UserRole.ADMIN, 'adm-a2');
    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'adm-rec');
    hmA = await makeUser(companyA, UserRole.HIRING_MANAGER, 'adm-hm');
    adminB = await makeUser(companyB, UserRole.ADMIN, 'adm-b');
    soleAdmin = await makeUser(soleAdminCompany, UserRole.ADMIN, 'adm-sole');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `adm-rec.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: adminB,
      email: `adm-b.${suffix}@test.local`,
      role: UserRole.ADMIN,
      companyId: companyB,
    };

    jobA = (await jobs.create(recA, { title: `Adm job ${suffix}` })).id;
    jobB = (await jobs.create(recB, { title: `Adm jobB ${suffix}` })).id;
  });

  afterAll(async () => {
    try {
      const companies = [companyA, companyB, soleAdminCompany];
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  // =========================================================================
  // GET /admin/users
  // =========================================================================
  describe('GET /admin/users', () => {
    it('lists the tenant’s users', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/users?limit=100')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const ids = response.body.data.map((u: { id: string }) => u.id);
      expect(ids).toContain(recruiterA);
      expect(ids).toContain(hmA);
    });

    it('never lists another tenant’s users', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/users?limit=100')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.body.data.map((u: { id: string }) => u.id)).not.toContain(adminB);
    });

    it('filters by role', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/users?role=RECRUITER&limit=100')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.body.data.every((u: { role: string }) => u.role === 'RECRUITER')).toBe(true);
    });

    it('rejects CANDIDATE as a role filter', async () => {
      await request(app.getHttpServer())
        .get('/admin/users?role=CANDIDATE')
        .set(auth(await tokenFor(adminA)))
        .expect(400);
    });

    it('never exposes a password hash', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/users?limit=100')
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
      expect(JSON.stringify(response.body)).not.toContain('password_hash');
    });

    it('paginates without repeating a row', async () => {
      const token = await tokenFor(adminA);
      const first = await request(app.getHttpServer())
        .get('/admin/users?limit=1')
        .set(auth(token))
        .expect(200);
      const second = await request(app.getHttpServer())
        .get(`/admin/users?limit=1&cursor=${first.body.nextCursor}`)
        .set(auth(token))
        .expect(200);

      expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    });
  });

  // =========================================================================
  // POST /admin/users
  // =========================================================================
  describe('POST /admin/users', () => {
    it('invites a user with no credential', async () => {
      const response = await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminA)))
        .send({ email: `invited.${suffix}@test.local`, role: 'RECRUITER' })
        .expect(201);

      expect(response.body).toMatchObject({ role: 'RECRUITER', invited: true });

      const row = await owner.users.findUniqueOrThrow({ where: { id: response.body.id } });
      // Approved: "invited" is the absence of a password, not a status column.
      expect(row.passwordHash).toBeNull();
      expect(row.companyId).toBe(companyA);
      userIds.push(row.id);
    });

    it('writes admin.user_invited', async () => {
      const response = await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminA)))
        .send({ email: `audited.${suffix}@test.local`, role: 'HIRING_MANAGER' })
        .expect(201);
      userIds.push(response.body.id);

      const row = await owner.auditLog.findFirstOrThrow({
        where: { resourceId: response.body.id, action: 'admin.user_invited' },
      });
      expect(row.actorId).toBe(adminA);
      expect(row.companyId).toBe(companyA);
    });

    it('409s on a duplicate email within the tenant', async () => {
      const email = `dupe.${suffix}@test.local`;
      const created = await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminA)))
        .send({ email, role: 'RECRUITER' })
        .expect(201);
      userIds.push(created.body.id);

      const response = await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminA)))
        .send({ email, role: 'RECRUITER' })
        .expect(409);

      expect(response.body.detail).toMatch(/already exists/i);
    });

    /** users has UNIQUE (company_id, email) — unique per tenant, not global. */
    it('allows the same email in a DIFFERENT tenant', async () => {
      const email = `shared.${suffix}@test.local`;

      const a = await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminA)))
        .send({ email, role: 'RECRUITER' })
        .expect(201);
      const b = await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminB)))
        .send({ email, role: 'RECRUITER' })
        .expect(201);

      userIds.push(a.body.id, b.body.id);
      expect(a.body.id).not.toBe(b.body.id);
    });

    /** Gap 5 rule 2 — candidate identity is not created here. */
    it('refuses to assign CANDIDATE', async () => {
      const response = await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminA)))
        .send({ email: `cand.${suffix}@test.local`, role: 'CANDIDATE' })
        .expect(400);

      expect(response.body.detail).toMatch(/ADMIN, RECRUITER or HIRING_MANAGER/);
    });

    it('rejects an invalid email', async () => {
      await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminA)))
        .send({ email: 'not-an-email', role: 'RECRUITER' })
        .expect(400);
    });

    it('rejects an attempt to set the tenant', async () => {
      await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminA)))
        .send({ email: `x.${suffix}@test.local`, role: 'RECRUITER', companyId: companyB })
        .expect(400);
    });
  });

  // =========================================================================
  // PATCH /admin/users/:id/role
  // =========================================================================
  describe('PATCH /admin/users/:id/role', () => {
    it('changes a role and audits before/after', async () => {
      const created = await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(await tokenFor(adminA)))
        .send({ email: `promote.${suffix}@test.local`, role: 'RECRUITER' })
        .expect(201);
      userIds.push(created.body.id);

      const response = await request(app.getHttpServer())
        .patch(`/admin/users/${created.body.id}/role`)
        .set(auth(await tokenFor(adminA)))
        .send({ role: 'HIRING_MANAGER' })
        .expect(200);

      expect(response.body.role).toBe('HIRING_MANAGER');

      const row = await owner.auditLog.findFirstOrThrow({
        where: { resourceId: created.body.id, action: 'admin.role_changed' },
      });
      expect(row.beforeState).toMatchObject({ role: 'RECRUITER' });
      expect(row.afterState).toMatchObject({ role: 'HIRING_MANAGER' });
    });

    /** Gap 5 rule 3 — without this a tenant can lock itself out of FR8.2/8.3. */
    it('422s on demoting the LAST administrator', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/admin/users/${soleAdmin}/role`)
        .set(auth(await tokenFor(soleAdmin)))
        .send({ role: 'RECRUITER' })
        .expect(422);

      expect(response.body.detail).toMatch(/last administrator/i);

      const row = await owner.users.findUniqueOrThrow({ where: { id: soleAdmin } });
      expect(row.role).toBe(UserRole.ADMIN);
    });

    it('allows demoting an administrator when another remains', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/users/${adminA2}/role`)
        .set(auth(await tokenFor(adminA)))
        .send({ role: 'RECRUITER' })
        .expect(200);

      // Restore for later tests.
      await owner.users.update({ where: { id: adminA2 }, data: { role: UserRole.ADMIN } });
    });

    it('refuses to assign CANDIDATE', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/users/${recruiterA}/role`)
        .set(auth(await tokenFor(adminA)))
        .send({ role: 'CANDIDATE' })
        .expect(400);
    });

    it('404s a user in another tenant', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/users/${adminB}/role`)
        .set(auth(await tokenFor(adminA)))
        .send({ role: 'RECRUITER' })
        .expect(404);

      const row = await owner.users.findUniqueOrThrow({ where: { id: adminB } });
      expect(row.role).toBe(UserRole.ADMIN);
    });

    it('a foreign user is indistinguishable from a missing one', async () => {
      const token = await tokenFor(adminA);
      const foreign = await request(app.getHttpServer())
        .patch(`/admin/users/${adminB}/role`)
        .set(auth(token))
        .send({ role: 'RECRUITER' })
        .expect(404);
      const missing = await request(app.getHttpServer())
        .patch(`/admin/users/${randomUUID()}/role`)
        .set(auth(token))
        .send({ role: 'RECRUITER' })
        .expect(404);

      expect(foreign.body.detail).toBe(missing.body.detail);
    });
  });

  // =========================================================================
  // DELETE /admin/users/:id/sessions
  // =========================================================================
  describe('DELETE /admin/users/:id/sessions (FR8.4)', () => {
    it('revokes every refresh token and reports the count', async () => {
      await sessions.register(recruiterA, randomUUID(), 600);
      await sessions.register(recruiterA, randomUUID(), 600);

      const response = await request(app.getHttpServer())
        .delete(`/admin/users/${recruiterA}/sessions`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.body.revokedCount).toBe(2);
      expect(response.body.revokedAt).toBeTruthy();
      await expect(sessions.countLive(recruiterA)).resolves.toBe(0);
    });

    it('reports zero when the user has no live sessions', async () => {
      const response = await request(app.getHttpServer())
        .delete(`/admin/users/${hmA}/sessions`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.body.revokedCount).toBe(0);
    });

    it('writes auth.sessions_revoked', async () => {
      await sessions.register(hmA, randomUUID(), 600);
      await request(app.getHttpServer())
        .delete(`/admin/users/${hmA}/sessions`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const row = await owner.auditLog.findFirstOrThrow({
        where: { resourceId: hmA, action: 'auth.sessions_revoked' },
      });
      expect(row.actorId).toBe(adminA);
    });

    /** Gap 6 rule 2 — logout is for ending your own session. */
    it('422s on self-revocation', async () => {
      const response = await request(app.getHttpServer())
        .delete(`/admin/users/${adminA}/sessions`)
        .set(auth(await tokenFor(adminA)))
        .expect(422);

      expect(response.body.detail).toMatch(/your own session/i);
    });

    it('404s a user in another tenant, revoking nothing', async () => {
      await sessions.register(adminB, randomUUID(), 600);

      await request(app.getHttpServer())
        .delete(`/admin/users/${adminB}/sessions`)
        .set(auth(await tokenFor(adminA)))
        .expect(404);

      await expect(sessions.countLive(adminB)).resolves.toBe(1);
      await sessions.revokeAll(adminB);
    });
  });

  // =========================================================================
  // PATCH /admin/jobs/:id/ai-scoring (FR8.2, BR-04)
  // =========================================================================
  describe('PATCH /admin/jobs/:id/ai-scoring', () => {
    it('an Administrator enables scoring', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/admin/jobs/${jobA}/ai-scoring`)
        .set(auth(await tokenFor(adminA)))
        .send({ enabled: true })
        .expect(200);

      expect(response.body).toMatchObject({ jobId: jobA, aiScoringEnabled: true });

      const row = await owner.job.findUniqueOrThrow({ where: { id: jobA } });
      expect(row.aiScoringEnabled).toBe(true);
    });

    it('and disables it again, explaining the FR4.5 consequence', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/admin/jobs/${jobA}/ai-scoring`)
        .set(auth(await tokenFor(adminA)))
        .send({ enabled: false })
        .expect(200);

      expect(response.body.aiScoringEnabled).toBe(false);
      expect(response.body.effect).toMatch(/newest first with no score/i);
    });

    it('writes admin.ai_scoring_changed with before/after', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/jobs/${jobA}/ai-scoring`)
        .set(auth(await tokenFor(adminA)))
        .send({ enabled: true })
        .expect(200);

      const row = await owner.auditLog.findFirstOrThrow({
        where: { resourceId: jobA, action: 'admin.ai_scoring_changed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.afterState).toMatchObject({ aiScoringEnabled: true });

      await owner.job.update({ where: { id: jobA }, data: { aiScoringEnabled: false } });
    });

    /** BR-04, the DoD line item: "Recruiter token on the AI toggle → 403". */
    it('BR-04: a Recruiter token gets 403', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/admin/jobs/${jobA}/ai-scoring`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ enabled: true })
        .expect(403);

      expect(response.body.status).toBe(403);

      const row = await owner.job.findUniqueOrThrow({ where: { id: jobA } });
      expect(row.aiScoringEnabled).toBe(false);
    });

    it('BR-04: a Hiring Manager token gets 403', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/jobs/${jobA}/ai-scoring`)
        .set(auth(await tokenFor(hmA)))
        .send({ enabled: true })
        .expect(403);
    });

    it('404s a job in another tenant', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/jobs/${jobB}/ai-scoring`)
        .set(auth(await tokenFor(adminA)))
        .send({ enabled: true })
        .expect(404);

      const row = await owner.job.findUniqueOrThrow({ where: { id: jobB } });
      expect(row.aiScoringEnabled).toBe(false);
    });

    it('rejects a non-boolean', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/jobs/${jobA}/ai-scoring`)
        .set(auth(await tokenFor(adminA)))
        .send({ enabled: 'yes' })
        .expect(400);
    });

    /** BR-01 — the AI surface never moves a candidate. */
    it('toggling scoring does not touch any application stage', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/jobs/${jobA}/ai-scoring`)
        .set(auth(await tokenFor(adminA)))
        .send({ enabled: true })
        .expect(200);

      await expect(
        owner.stageHistory.count({ where: { application: { jobId: jobA } } }),
      ).resolves.toBe(0);
      await owner.job.update({ where: { id: jobA }, data: { aiScoringEnabled: false } });
    });
  });

  // =========================================================================
  // Authorisation across the module
  // =========================================================================
  describe('authorisation', () => {
    it('every admin route requires authentication', async () => {
      const server = app.getHttpServer();

      await request(server).get('/admin/users').expect(401);
      await request(server).post('/admin/users').send({}).expect(401);
      await request(server).patch(`/admin/users/${hmA}/role`).send({}).expect(401);
      await request(server).delete(`/admin/users/${hmA}/sessions`).expect(401);
      await request(server).patch(`/admin/jobs/${jobA}/ai-scoring`).send({}).expect(401);
    });

    it('refuses a Recruiter on every admin route', async () => {
      const token = await tokenFor(recruiterA);

      await request(app.getHttpServer()).get('/admin/users').set(auth(token)).expect(403);
      await request(app.getHttpServer())
        .post('/admin/users')
        .set(auth(token))
        .send({ email: `nope.${suffix}@test.local`, role: 'RECRUITER' })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/admin/users/${hmA}/role`)
        .set(auth(token))
        .send({ role: 'RECRUITER' })
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/admin/users/${hmA}/sessions`)
        .set(auth(token))
        .expect(403);
    });

    it('refuses a Hiring Manager on every admin route', async () => {
      const token = await tokenFor(hmA);
      await request(app.getHttpServer()).get('/admin/users').set(auth(token)).expect(403);
      await request(app.getHttpServer())
        .delete(`/admin/users/${recruiterA}/sessions`)
        .set(auth(token))
        .expect(403);
    });
  });
});
