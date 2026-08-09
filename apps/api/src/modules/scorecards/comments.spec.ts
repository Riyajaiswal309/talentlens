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
 * FR5.3 comments — the half that had no table until the remaining-gaps pass.
 *
 * The visibility rule is the interesting part: "visible to the full hiring
 * team" has to mean the same set of people for comments as for scorecards,
 * or the requirement is delivered inconsistently.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Comments (FR5.3)', () => {
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
  let jobB = '';
  let applicationId = '';

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

  const post = (id: string, body: object, token: string) =>
    request(app.getHttpServer()).post(`/applications/${id}/comments`).set(auth(token)).send(body);

  const list = (id: string, token: string) =>
    request(app.getHttpServer()).get(`/applications/${id}/comments`).set(auth(token));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        NotificationsModule,
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

    const a = await prisma.company.create({ data: { name: `CmA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `CmB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
      });
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'cm-rec-a');
    adminA = await makeUser(companyA, UserRole.ADMIN, 'cm-adm-a');
    hmAssigned = await makeUser(companyA, UserRole.HIRING_MANAGER, 'cm-hm-yes');
    hmUnassigned = await makeUser(companyA, UserRole.HIRING_MANAGER, 'cm-hm-no');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'cm-rec-b');
    candidateUser = await makeUser(companyA, UserRole.CANDIDATE, 'cm-cand');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `cm-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: recruiterB,
      email: `cm-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    const created = await jobs.create(recA, { title: `Cm job ${suffix}` });
    await jobs.update(recA, created.id, { status: JobStatus.PUBLISHED });
    jobAssigned = created.id;
    await prisma.jobAssignment.create({ data: { jobId: jobAssigned, userId: hmAssigned } });

    const createdB = await jobs.create(recB, { title: `Cm jobB ${suffix}` });
    await jobs.update(recB, createdB.id, { status: JobStatus.PUBLISHED });
    jobB = createdB.id;

    applicationId = (
      await applications.submit(
        { jobId: jobAssigned, fullName: 'Cm Candidate', email: `cmcand.${suffix}@test.local` },
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

      await owner.comment.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
      await owner.candidate.deleteMany({ where: { email: { contains: suffix } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  describe('posting', () => {
    it('a Recruiter comments and gets the author back', async () => {
      const response = await post(
        applicationId,
        { body: 'Strong on system design.' },
        await tokenFor(recruiterA),
      ).expect(201);

      expect(response.body).toMatchObject({
        body: 'Strong on system design.',
        author: { id: recruiterA, role: 'RECRUITER' },
      });
      expect(response.body.createdAt).toBeTruthy();
    });

    it('an assigned Hiring Manager may comment (FR5.3 collaboration)', async () => {
      await post(applicationId, { body: 'Agreed.' }, await tokenFor(hmAssigned)).expect(201);
    });

    it('an Admin may comment', async () => {
      await post(applicationId, { body: 'Noted.' }, await tokenFor(adminA)).expect(201);
    });

    it('trims the body', async () => {
      const response = await post(
        applicationId,
        { body: '  spaced  ' },
        await tokenFor(recruiterA),
      ).expect(201);
      expect(response.body.body).toBe('spaced');
    });

    it('rejects an empty or whitespace-only body', async () => {
      const token = await tokenFor(recruiterA);
      await post(applicationId, { body: '' }, token).expect(400);
      await post(applicationId, { body: '   ' }, token).expect(400);
    });

    it('rejects a body over 5000 characters', async () => {
      await post(applicationId, { body: 'x'.repeat(5001) }, await tokenFor(recruiterA)).expect(400);
    });

    it('rejects a spoofed author', async () => {
      await post(applicationId, { body: 'x', authorId: adminA }, await tokenFor(recruiterA)).expect(
        400,
      );
    });
  });

  describe('team visibility', () => {
    it('the whole team sees every comment, not just their own', async () => {
      const response = await list(applicationId, await tokenFor(hmAssigned)).expect(200);

      const authors = response.body.data.map((c: { author: { id: string } }) => c.author.id);
      expect(authors).toContain(recruiterA);
      expect(authors).toContain(hmAssigned);
      expect(authors).toContain(adminA);
    });

    it('orders oldest first — a thread reads forwards', async () => {
      const response = await list(applicationId, await tokenFor(recruiterA)).expect(200);
      const times = response.body.data.map((c: { createdAt: string }) =>
        new Date(c.createdAt).getTime(),
      );
      expect([...times].sort((x, y) => x - y)).toEqual(times);
    });

    it('returns an empty list, not an error, when nobody has commented', async () => {
      const other = (
        await applications.submit(
          { jobId: jobAssigned, fullName: 'Quiet', email: `quiet.${suffix}@test.local` },
          pdf(),
          CORRELATION,
        )
      ).application.id;

      const response = await list(other, await tokenFor(recruiterA)).expect(200);
      expect(response.body.data).toEqual([]);
    });
  });

  describe('authorisation', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .post(`/applications/${applicationId}/comments`)
        .send({ body: 'x' })
        .expect(401);
      await request(app.getHttpServer()).get(`/applications/${applicationId}/comments`).expect(401);
    });

    /** The team talks about the candidate, not to them. */
    it('a CANDIDATE can neither post nor read', async () => {
      const token = await tokenFor(candidateUser);
      await post(applicationId, { body: 'let me in' }, token).expect(403);
      await list(applicationId, token).expect(403);
    });

    /** Same rule as scorecards — §24.2 assigned jobs only. */
    it('an UNASSIGNED Hiring Manager gets 404 on both', async () => {
      const token = await tokenFor(hmUnassigned);
      await post(applicationId, { body: 'x' }, token).expect(404);
      await list(applicationId, token).expect(404);
    });

    it('BR-06: another tenant gets 404, and writes nothing', async () => {
      const token = await tokenFor(recruiterB);
      const before = await owner.comment.count({ where: { applicationId } });

      await post(applicationId, { body: 'x' }, token).expect(404);
      await list(applicationId, token).expect(404);

      await expect(owner.comment.count({ where: { applicationId } })).resolves.toBe(before);
    });

    it('an unassigned application is indistinguishable from a missing one', async () => {
      const token = await tokenFor(hmUnassigned);
      const unassigned = await list(applicationId, token).expect(404);
      const missing = await list(randomUUID(), token).expect(404);

      expect(unassigned.body.detail).toBe(missing.body.detail);
    });

    it('cannot reach an application in another tenant from the other direction', async () => {
      const inB = (
        await applications.submit(
          { jobId: jobB, fullName: 'Other', email: `other.${suffix}@test.local` },
          pdf(),
          CORRELATION,
        )
      ).application.id;

      await post(inB, { body: 'x' }, await tokenFor(recruiterA)).expect(404);
    });

    it('rejects a malformed application id', async () => {
      await request(app.getHttpServer())
        .get('/applications/not-a-uuid/comments')
        .set(auth(await tokenFor(recruiterA)))
        .expect(400);
    });
  });
});
