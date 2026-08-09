import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ApplicationsModule } from './applications.module';
import { MAX_RESUME_BYTES } from './resume-file';
import { CommonModule } from '../../common/common.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { CorrelationIdMiddleware } from '../../common/middleware/correlation-id.middleware';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * HTTP-level tests for POST /v1/applications.
 *
 * These exist because the service tests call `submit()` directly and so never
 * load the multipart machinery. That gap let a missing `multer` dependency
 * pass every gate — typecheck, lint, build and 170 unit tests — and fail only
 * when the built server was started. Booting the real Nest request pipeline
 * here is what closes it.
 *
 * Guards and the audit interceptor are registered globally in main.ts, not by
 * this module, so they are out of scope here and covered by their own suites.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('ApplicationsController (multipart intake)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;

  const suffix = randomUUID().slice(0, 8);
  let companyId = '';
  let publishedJobId = '';

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        NotificationsModule,
        ApplicationsModule,
      ],
      providers: [JobsService],
    }).compile();

    app = moduleRef.createNestApplication();
    /*
     * AppModule applies this to every route (NFR11) and the handler now
     * refuses to run without a correlation id, because an empty one would
     * publish an untraceable queue job. Applied here so the test harness
     * matches the real pipeline rather than working around it.
     */
    app.use((req: RequestContext, res: Response, next: NextFunction) =>
      new CorrelationIdMiddleware().use(req, res, next),
    );
    // Mirrors main.ts so DTO rejection behaves as it does in production.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jobs = moduleRef.get(JobsService);

    const company = await prisma.company.create({
      data: { name: `Ctrl ${suffix}`, dataRegion: 'test' },
    });
    companyId = company.id;

    const user = await prisma.users.create({
      data: { companyId, role: UserRole.RECRUITER, email: `ctrl-rec.${suffix}@test.local` },
    });
    const recruiter: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId,
    };

    const job = await jobs.create(recruiter, { title: `Ctrl job ${suffix}` });
    await jobs.update(recruiter, job.id, { status: JobStatus.PUBLISHED });
    publishedJobId = job.id;
  });

  /**
   * M2.10 — audit_logs.company_id is ON DELETE RESTRICT (PRD §18 keeps the
   * audit trail out of cascade deletes), so this run's audit rows must go
   * before its company can. Only the OWNER may delete them: the application
   * role holds INSERT and SELECT alone (PRD §17.3).
   */
  async function clearAuditFor(companyId: string): Promise<void> {
    const owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    try {
      await owner.$connect();
      await owner.auditLog.deleteMany({ where: { companyId } });
    } finally {
      await owner.$disconnect();
    }
  }

  afterAll(async () => {
    await clearAuditFor(companyId);
    await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.candidate.deleteMany({ where: { email: { contains: suffix } } });
    await app.close();
  });

  function post(email: string) {
    return request(app.getHttpServer())
      .post('/applications')
      .field('jobId', publishedJobId)
      .field('fullName', 'Ada Lovelace')
      .field('email', `${email}.${suffix}@test.local`);
  }

  it('accepts a multipart submission and returns 201', async () => {
    const response = await post('ok')
      .attach('resume', pdf, { filename: 'resume.pdf', contentType: 'application/pdf' })
      .expect(201);

    expect(response.body).toMatchObject({
      jobId: publishedJobId,
      currentStage: 'Applied',
    });
    expect(response.body.reference).toHaveLength(8);
  });

  it('rejects a submission with no file at all', async () => {
    const response = await post('nofile').expect(400);

    expect(response.body.detail).toMatch(/Attach your resume/i);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects a non-PDF/DOCX attachment', async () => {
    const response = await post('txt')
      .attach('resume', Buffer.from('hello'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(400);

    expect(response.body.detail).toMatch(/PDF or DOCX/i);
  });

  /**
   * Multer aborts oversized uploads itself and throws a raw MulterError, which
   * is not an HttpException. Without UploadExceptionFilter this is a 500.
   */
  it('decision C: returns 413 for a file over 10 MB', async () => {
    const oversized = Buffer.concat([pdf, Buffer.alloc(MAX_RESUME_BYTES)]);

    const response = await post('big')
      .attach('resume', oversized, { filename: 'big.pdf', contentType: 'application/pdf' })
      .expect(413);

    expect(response.body.detail).toMatch(/10 MB or smaller/i);
    expect(response.body.status).toBe(413);
  });

  it('rejects a file sent under the wrong field name', async () => {
    const response = await post('wrongfield')
      .attach('cv', pdf, { filename: 'resume.pdf', contentType: 'application/pdf' })
      .expect(400);

    expect(response.body.detail).toMatch(/single field named "resume"/i);
  });

  it('rejects the EICAR test file through the scanner boundary', async () => {
    const eicar = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
    ]);

    const response = await post('eicar')
      .attach('resume', eicar, { filename: 'resume.pdf', contentType: 'application/pdf' })
      .expect(400);

    expect(response.body.detail).toMatch(/failed our security scan/i);
  });

  it('validates the text fields as well as the file', async () => {
    const response = await request(app.getHttpServer())
      .post('/applications')
      .field('jobId', 'not-a-uuid')
      .field('fullName', '')
      .field('email', 'nope')
      .attach('resume', pdf, { filename: 'resume.pdf', contentType: 'application/pdf' })
      .expect(400);

    expect(response.body.detail).toMatch(/valid job identifier/i);
    expect(response.body.detail).toMatch(/valid email address/i);
  });

  it('rejects an unexpected extra field (forbidNonWhitelisted)', async () => {
    const response = await post('extra')
      .field('aiScoringEnabled', 'true')
      .attach('resume', pdf, { filename: 'resume.pdf', contentType: 'application/pdf' })
      .expect(400);

    expect(response.body.detail).toMatch(/aiScoringEnabled/);
  });
});
