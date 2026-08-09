import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AdminModule } from './admin.module';
import { ApplicationsModule } from '../applications/applications.module';
import { ApplicationsService } from '../applications/applications.service';
import { AuditService } from '../../common/audit/audit.service';
import { CommonModule } from '../../common/common.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { CandidateOwnershipGuard } from '../../common/guards/candidate-ownership.guard';
import { JobAssignmentGuard } from '../../common/guards/job-assignment.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';
import { CorrelationIdInterceptor } from '../../common/interceptors/correlation-id.interceptor';
import { CorrelationIdMiddleware } from '../../common/middleware/correlation-id.middleware';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TokenService } from '../auth/token.service';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import { PipelineModule } from '../pipeline/pipeline.module';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * BR-05 erasure and FR2.3 notifications.
 *
 * The erasure tests are mostly about what SURVIVES. PRD §18 requires the
 * audit skeleton to remain intact, so "did the PII go" is only half the
 * property — "is the history still reconstructable" is the other half.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('BR-05 erasure and FR2.3 notifications', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaService;
  let jobs: JobsService;
  let applications: ApplicationsService;
  let tokens: TokenService;
  let notifications: NotificationsService;
  let storage: StorageService;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;

  let companyA = '';
  let companyB = '';
  let adminA = '';
  let recruiterA = '';
  let adminB = '';
  let jobA = '';
  let jobB = '';

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

  async function newApplication(tag: string, job = jobA) {
    return applications.submit(
      { jobId: job, fullName: `Erase ${tag}`, email: `${tag}.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
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
        PipelineModule,
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
    applications = moduleRef.get(ApplicationsService);
    tokens = moduleRef.get(TokenService);
    notifications = moduleRef.get(NotificationsService);
    storage = moduleRef.get(StorageService);

    owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await owner.$connect();

    const a = await prisma.company.create({ data: { name: `ErA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `ErB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local`, passwordHash: 'x' },
      });
      return user.id;
    }

    adminA = await makeUser(companyA, UserRole.ADMIN, 'er-adm-a');
    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'er-rec-a');
    adminB = await makeUser(companyB, UserRole.ADMIN, 'er-adm-b');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `er-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: adminB,
      email: `er-adm-b.${suffix}@test.local`,
      role: UserRole.ADMIN,
      companyId: companyB,
    };

    const created = await jobs.create(recA, { title: `Er job ${suffix}` });
    await jobs.update(recA, created.id, { status: JobStatus.PUBLISHED });
    jobA = created.id;

    const createdB = await jobs.create(recB, { title: `Er jobB ${suffix}` });
    await jobs.update(recB, createdB.id, { status: JobStatus.PUBLISHED });
    jobB = createdB.id;
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

      await owner.stageHistory.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.auditLog.deleteMany({ where: { companyId: { in: companies } } });
      await owner.company.deleteMany({ where: { id: { in: companies } } });
      await owner.candidate.deleteMany({ where: { email: { contains: suffix } } });
      await owner.candidate.deleteMany({ where: { email: { contains: 'erased+' } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  // =========================================================================
  // BR-05
  // =========================================================================
  describe('DELETE /admin/candidates/:id (BR-05)', () => {
    it('detaches the PII', async () => {
      const submitted = await newApplication('pii');

      const response = await request(app.getHttpServer())
        .delete(`/admin/candidates/${submitted.candidate.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      expect(response.body.applicationsRetained).toBe(1);

      const candidate = await owner.candidate.findUniqueOrThrow({
        where: { id: submitted.candidate.id },
      });
      expect(candidate.fullName).toBe('Erased candidate');
      expect(candidate.email).not.toContain(suffix);
      expect(candidate.phone).toBeNull();
      expect(candidate.deletedAt).toBeTruthy();
      expect(candidate.erasedBy).toBe(adminA);
    });

    /** PRD §18 — "leaving the audit skeleton intact". */
    it('retains the application, its history and the audit trail', async () => {
      // Submitted over HTTP so the AuditInterceptor actually writes a record —
      // the service call used elsewhere in this suite bypasses it.
      const posted = await request(app.getHttpServer())
        .post('/applications')
        .field('jobId', jobA)
        .field('fullName', 'Erase skeleton')
        .field('email', `skeleton.${suffix}@test.local`)
        .attach('resume', Buffer.from('%PDF-1.4\n%%EOF\n'), {
          filename: 'r.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      const applicationId = posted.body.id as string;
      const submitted = {
        candidate: await owner.candidate.findFirstOrThrow({
          where: { email: `skeleton.${suffix}@test.local` },
        }),
      };

      await request(app.getHttpServer())
        .delete(`/admin/candidates/${submitted.candidate.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      // The application row survives, still pointing at the candidate id.
      const application = await owner.application.findUnique({ where: { id: applicationId } });
      expect(application).not.toBeNull();
      expect(application?.candidateId).toBe(submitted.candidate.id);

      // And so does the submission's audit record.
      const audits = await owner.auditLog.count({
        where: { resourceId: applicationId, action: 'application.submitted' },
      });
      expect(audits).toBeGreaterThan(0);
    });

    it('removes the parsed profile and clears the resume pointer', async () => {
      const submitted = await newApplication('resume');
      const resume = await owner.resume.findFirstOrThrow({
        where: { applicationId: submitted.application.id },
      });
      await owner.parsedProfile.create({
        data: { resumeId: resume.id, skills: ['x'], workHistory: [] },
      });

      const deleted = jest.spyOn(storage, 'deleteQuietly').mockResolvedValue();

      await request(app.getHttpServer())
        .delete(`/admin/candidates/${submitted.candidate.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      await expect(owner.parsedProfile.count({ where: { resumeId: resume.id } })).resolves.toBe(0);

      const after = await owner.resume.findUniqueOrThrow({ where: { id: resume.id } });
      expect(after.s3Key).toBe('');
      // The stored file is removed too — detaching the pointer alone would
      // leave the PII sitting in the bucket.
      expect(deleted).toHaveBeenCalledWith(resume.s3Key);
      deleted.mockRestore();
    });

    it('unlinks any login account', async () => {
      const submitted = await newApplication('login');
      const candidateUser = await prisma.users.create({
        data: {
          companyId: companyA,
          role: UserRole.CANDIDATE,
          email: `er-cand.${suffix}@test.local`,
        },
      });
      await owner.candidate.update({
        where: { id: submitted.candidate.id },
        data: { userId: candidateUser.id },
      });

      await request(app.getHttpServer())
        .delete(`/admin/candidates/${submitted.candidate.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const candidate = await owner.candidate.findUniqueOrThrow({
        where: { id: submitted.candidate.id },
      });
      expect(candidate.userId).toBeNull();
    });

    it('writes candidate.erased with no PII in the record', async () => {
      const submitted = await newApplication('audit');

      await request(app.getHttpServer())
        .delete(`/admin/candidates/${submitted.candidate.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);

      const row = await owner.auditLog.findFirstOrThrow({
        where: { resourceId: submitted.candidate.id, action: 'candidate.erased' },
      });
      expect(row.actorId).toBe(adminA);
      expect(row.companyId).toBe(companyA);
      // An audit record quoting the erased name would preserve the very
      // thing the request asked to remove.
      expect(JSON.stringify(row.afterState)).not.toContain(suffix);
      expect(JSON.stringify(row.afterState)).not.toContain('Erase audit');
    });

    it('refuses to erase the same candidate twice', async () => {
      const submitted = await newApplication('twice');
      const token = await tokenFor(adminA);

      await request(app.getHttpServer())
        .delete(`/admin/candidates/${submitted.candidate.id}`)
        .set(auth(token))
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/admin/candidates/${submitted.candidate.id}`)
        .set(auth(token))
        .expect(404);
    });

    // ---- authorisation ---------------------------------------------------

    it('requires an Administrator', async () => {
      const submitted = await newApplication('authz');

      await request(app.getHttpServer())
        .delete(`/admin/candidates/${submitted.candidate.id}`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(403);

      const candidate = await owner.candidate.findUniqueOrThrow({
        where: { id: submitted.candidate.id },
      });
      expect(candidate.deletedAt).toBeNull();
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).delete(`/admin/candidates/${randomUUID()}`).expect(401);
    });

    it('BR-06: 404s a candidate in another tenant, erasing nothing', async () => {
      const inB = await newApplication('cross', jobB);

      await request(app.getHttpServer())
        .delete(`/admin/candidates/${inB.candidate.id}`)
        .set(auth(await tokenFor(adminA)))
        .expect(404);

      const candidate = await owner.candidate.findUniqueOrThrow({
        where: { id: inB.candidate.id },
      });
      expect(candidate.deletedAt).toBeNull();
      expect(candidate.fullName).toBe('Erase cross');
    });

    it('a foreign candidate is indistinguishable from a missing one', async () => {
      const inB = await newApplication('cross2', jobB);
      const token = await tokenFor(adminA);

      const foreign = await request(app.getHttpServer())
        .delete(`/admin/candidates/${inB.candidate.id}`)
        .set(auth(token))
        .expect(404);
      const missing = await request(app.getHttpServer())
        .delete(`/admin/candidates/${randomUUID()}`)
        .set(auth(token))
        .expect(404);

      expect(foreign.body.detail).toBe(missing.body.detail);
    });
  });

  // =========================================================================
  // FR2.3
  // =========================================================================
  describe('FR2.3 notifications', () => {
    it('sends a confirmation when an application is submitted', async () => {
      const sent = jest.spyOn(notifications, 'applicationReceived');

      const submitted = await request(app.getHttpServer())
        .post('/applications')
        .field('jobId', jobA)
        .field('fullName', 'Notify Me')
        .field('email', `notify.${suffix}@test.local`)
        .attach('resume', Buffer.from('%PDF-1.4\n%%EOF\n'), {
          filename: 'r.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({
          email: `notify.${suffix}@test.local`,
          candidateName: 'Notify Me',
          reference: submitted.body.reference,
        }),
      );
      sent.mockRestore();
    });

    it('sends a status-change notification on a stage move', async () => {
      const submitted = await newApplication('stage');
      const sent = jest.spyOn(notifications, 'applicationStatusChanged');

      await request(app.getHttpServer())
        .patch(`/applications/${submitted.application.id}/stage`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ toStage: 'Screening' })
        .expect(200);

      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ toStage: 'Screening', isTerminal: false }),
      );
      sent.mockRestore();
    });

    it('marks a terminal move as terminal', async () => {
      const submitted = await newApplication('terminal');
      const sent = jest.spyOn(notifications, 'applicationStatusChanged');

      await request(app.getHttpServer())
        .patch(`/applications/${submitted.application.id}/stage`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ toStage: 'Rejected' })
        .expect(200);

      expect(sent).toHaveBeenCalledWith(expect.objectContaining({ isTerminal: true }));
      sent.mockRestore();
    });

    it('does NOT notify on a no-op stage move', async () => {
      const submitted = await newApplication('noop');
      const sent = jest.spyOn(notifications, 'applicationStatusChanged');

      await request(app.getHttpServer())
        .patch(`/applications/${submitted.application.id}/stage`)
        .set(auth(await tokenFor(recruiterA)))
        .send({ toStage: 'Applied' })
        .expect(200);

      expect(sent).not.toHaveBeenCalled();
      sent.mockRestore();
    });

    /**
     * FR2.5 — intake is independent of everything downstream. A transport
     * failure must not cost the candidate their application.
     */
    it('a transport failure does not fail the request', async () => {
      const broken = jest
        .spyOn(notifications, 'applicationReceived')
        .mockRejectedValue(new Error('SMTP down'));

      // The spy bypasses the service's own catch, so this proves the CALLER
      // is protected too and not merely relying on the service behaving.
      await request(app.getHttpServer())
        .post('/applications')
        .field('jobId', jobA)
        .field('fullName', 'Resilient')
        .field('email', `resilient.${suffix}@test.local`)
        .attach('resume', Buffer.from('%PDF-1.4\n%%EOF\n'), {
          filename: 'r.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      broken.mockRestore();
    });
  });

  // =========================================================================
  // Malformed cursor — the three DTOs that used to 500
  // =========================================================================
  describe('malformed cursor returns 400, not 500', () => {
    it('GET /jobs', async () => {
      const response = await request(app.getHttpServer())
        .get('/jobs?cursor=nonsense')
        .set(auth(await tokenFor(recruiterA)))
        .expect(400);
      expect(response.body.detail).toMatch(/not a valid page marker/i);
    });

    it('GET /public/jobs', async () => {
      await request(app.getHttpServer()).get('/public/jobs?cursor=nonsense').expect(400);
    });

    it('GET /jobs/:id/candidates', async () => {
      await request(app.getHttpServer())
        .get(`/jobs/${jobA}/candidates?cursor=nonsense`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(400);
    });

    it('a valid cursor still works', async () => {
      await request(app.getHttpServer())
        .get(`/jobs?cursor=${randomUUID()}&limit=5`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);
    });
  });
});
