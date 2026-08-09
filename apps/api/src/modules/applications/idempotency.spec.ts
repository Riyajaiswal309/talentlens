import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ApplicationsModule } from './applications.module';
import { AuditService } from '../../common/audit/audit.service';
import { CommonModule } from '../../common/common.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';
import { CorrelationIdInterceptor } from '../../common/interceptors/correlation-id.interceptor';
import { CorrelationIdMiddleware } from '../../common/middleware/correlation-id.middleware';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ResumeQueueService } from '../../common/queue/resume-queue.service';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * `Idempotency-Key` on POST /v1/applications (PRD §23.1, Phase 1 line 1265).
 *
 * The specification is two sentences: the header is SUPPORTED on this
 * endpoint, and it PREVENTS DUPLICATE SUBMISSION. These tests assert exactly
 * that — and, crucially, assert the absence of every side effect a duplicate
 * would have produced: no second application row, no second candidate, no
 * second resume, no second S3 object, no second audit record, no second queue
 * job.
 *
 * Run over HTTP with the real AuditInterceptor registered, because "no
 * duplicate audit record" is only true if the interceptor actually runs.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Idempotency-Key (PRD §23.1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;
  let queue: ResumeQueueService;
  let idempotency: IdempotencyService;
  /** Every key this run handed out, so afterAll can clear exactly those. */
  const issuedKeys: string[] = [];

  const suffix = randomUUID().slice(0, 8);
  let companyId = '';
  let jobId = '';
  let otherJobId = '';

  /** Mint a key and remember it for cleanup. */
  function newKey(): string {
    const key = `k-${randomUUID()}`;
    issuedKeys.push(key);
    return key;
  }

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const otherPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        NotificationsModule,
        JobsModule,
        ApplicationsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: RequestContext, res: Response, next: NextFunction) =>
      new CorrelationIdMiddleware().use(req, res, next),
    );

    // The audit interceptor is the point of several assertions below, so it
    // is registered here in main.ts's order rather than omitted.
    const reflector = app.get(Reflector);
    app.useGlobalInterceptors(
      new CorrelationIdInterceptor(),
      new AuditInterceptor(reflector, app.get(AuditService)),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jobs = moduleRef.get(JobsService);
    queue = moduleRef.get(ResumeQueueService);
    idempotency = moduleRef.get(IdempotencyService);

    const company = await prisma.company.create({
      data: { name: `Idem ${suffix}`, dataRegion: 'test' },
    });
    companyId = company.id;

    const user = await prisma.users.create({
      data: { companyId, role: UserRole.RECRUITER, email: `idem-rec.${suffix}@test.local` },
    });
    const recruiter: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId,
    };

    const job = await jobs.create(recruiter, { title: `Idem job ${suffix}` });
    await jobs.update(recruiter, job.id, { status: JobStatus.PUBLISHED });
    jobId = job.id;

    const other = await jobs.create(recruiter, { title: `Idem other ${suffix}` });
    await jobs.update(recruiter, other.id, { status: JobStatus.PUBLISHED });
    otherJobId = other.id;
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

    // Drop this run's idempotency records rather than waiting out their
    // 24-hour TTL in a shared dev Redis. Matched on the key prefix used
    // above, so nothing else is touched.
    for (const key of issuedKeys) {
      await idempotency.release('applications', key);
    }

    await app.close();
  });

  function submit(email: string, options: { key?: string; job?: string; file?: Buffer } = {}) {
    const req = request(app.getHttpServer())
      .post('/applications')
      .field('jobId', options.job ?? jobId)
      .field('fullName', 'Ada Lovelace')
      .field('email', `${email}.${suffix}@test.local`);

    if (options.key) req.set('Idempotency-Key', options.key);

    return req.attach('resume', options.file ?? pdf, {
      filename: 'resume.pdf',
      contentType: 'application/pdf',
    });
  }

  /** Every side effect one submission produces, counted. */
  async function sideEffects(email: string) {
    const fullEmail = `${email}.${suffix}@test.local`;
    const candidates = await prisma.candidate.findMany({ where: { email: fullEmail } });
    const applications = await prisma.application.findMany({
      where: { candidate: { email: fullEmail } },
      include: { resume: true },
    });
    const audits = await prisma.auditLog.findMany({
      where: {
        action: 'application.submitted',
        resourceId: { in: applications.map((a) => a.id) },
      },
    });

    return {
      candidates: candidates.length,
      applications: applications.length,
      resumes: applications.filter((a) => a.resume).length,
      audits: audits.length,
    };
  }

  // =========================================================================
  // The specified behaviour
  // =========================================================================
  it('is OPTIONAL — a request with no key behaves exactly as before', async () => {
    const response = await submit('nokey').expect(201);

    expect(response.body.currentStage).toBe('Applied');
    await expect(sideEffects('nokey')).resolves.toEqual({
      candidates: 1,
      applications: 1,
      resumes: 1,
      audits: 1,
    });
  });

  it('two requests WITHOUT a key create two applications — no accidental dedup', async () => {
    await submit('twice').expect(201);
    await submit('twice').expect(201);

    const effects = await sideEffects('twice');
    expect(effects.applications).toBe(2);
  });

  it('first request with a key succeeds normally', async () => {
    const response = await submit('first', { key: newKey() }).expect(201);

    expect(response.body.id).toBeTruthy();
    expect(response.body.reference).toHaveLength(8);
    await expect(sideEffects('first')).resolves.toEqual({
      candidates: 1,
      applications: 1,
      resumes: 1,
      audits: 1,
    });
  });

  /** The requirement, stated plainly: "prevents duplicate submission". */
  it('a repeat with the SAME key replays the original response', async () => {
    const key = newKey();

    const first = await submit('replay', { key }).expect(201);
    const second = await submit('replay', { key }).expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.body.id).toBe(first.body.id);
  });

  it('a repeat creates NO duplicate application, candidate, resume or audit', async () => {
    const key = newKey();

    await submit('nodupe', { key }).expect(201);
    await submit('nodupe', { key }).expect(201);
    await submit('nodupe', { key }).expect(201);

    // Three requests, one of everything.
    await expect(sideEffects('nodupe')).resolves.toEqual({
      candidates: 1,
      applications: 1,
      resumes: 1,
      audits: 1,
    });
  });

  /**
   * A replay changes nothing, so PRD §17.3 has nothing to record. Asserted
   * separately from the count above because a second audit row is the
   * failure mode most easily missed — the response would look correct.
   */
  it('a replay writes NO second audit record', async () => {
    const key = newKey();

    const first = await submit('audit1', { key }).expect(201);
    await submit('audit1', { key }).expect(201);

    const rows = await prisma.auditLog.findMany({
      where: { action: 'application.submitted', resourceId: first.body.id },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorType).toBe('PUBLIC');
    expect(rows[0]?.actorId).toBeNull();
  });

  it('a replay publishes NO second resume.uploaded event', async () => {
    const key = newKey();
    const publish = jest.spyOn(queue, 'publishResumeUploaded');

    try {
      await submit('queue1', { key }).expect(201);
      expect(publish).toHaveBeenCalledTimes(1);

      await submit('queue1', { key }).expect(201);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      publish.mockRestore();
    }
  });

  it('a replay stores NO second file', async () => {
    const key = newKey();

    await submit('storage1', { key }).expect(201);
    await submit('storage1', { key }).expect(201);

    const resumes = await prisma.resume.findMany({
      where: { application: { candidate: { email: `storage1.${suffix}@test.local` } } },
    });

    // One resume row, and therefore one object key — the second request
    // never reached storage at all.
    expect(resumes).toHaveLength(1);
  });

  it('DIFFERENT keys create different applications', async () => {
    await submit('distinct', { key: newKey() }).expect(201);
    await submit('distinct', { key: newKey() }).expect(201);

    const effects = await sideEffects('distinct');
    expect(effects.applications).toBe(2);
  });

  // =========================================================================
  // Same key, DIFFERENT request — NOT specified by the PRD (see report)
  // =========================================================================
  describe('same key with a different request (unspecified — refused)', () => {
    it('409s when the job differs', async () => {
      const key = newKey();
      await submit('mismatch1', { key }).expect(201);

      const response = await submit('mismatch1', { key, job: otherJobId }).expect(409);
      expect(response.body.detail).toMatch(/different submission/i);
    });

    it('409s when the attached file differs', async () => {
      const key = newKey();
      await submit('mismatch2', { key }).expect(201);

      await submit('mismatch2', { key, file: otherPdf }).expect(409);
    });

    it('409s when the applicant email differs', async () => {
      const key = newKey();
      await submit('mismatch3a', { key }).expect(201);

      const response = await submit('mismatch3b', { key }).expect(409);
      expect(response.body.status).toBe(409);
    });

    it('a refused mismatch creates nothing', async () => {
      const key = newKey();
      await submit('mismatch4', { key }).expect(201);
      await submit('mismatch5', { key }).expect(409);

      await expect(sideEffects('mismatch5')).resolves.toEqual({
        candidates: 0,
        applications: 0,
        resumes: 0,
        audits: 0,
      });
    });
  });

  // =========================================================================
  // Key handling
  // =========================================================================
  describe('key handling', () => {
    /**
     * A rejected submission created nothing, so it must not burn the key —
     * otherwise a candidate whose file was rejected could never retry with
     * the same key after fixing it.
     */
    it('a FAILED attempt releases the key for a corrected retry', async () => {
      const key = newKey();

      await request(app.getHttpServer())
        .post('/applications')
        .set('Idempotency-Key', key)
        .field('jobId', jobId)
        .field('fullName', 'Retry Me')
        .field('email', `retry.${suffix}@test.local`)
        .attach('resume', Buffer.from('not a pdf'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        })
        .expect(400);

      // Same key, corrected file — must succeed rather than 409.
      await submit('retry', { key }).expect(201);
      const effects = await sideEffects('retry');
      expect(effects.applications).toBe(1);
    });

    it('rejects an absurdly long key', async () => {
      const response = await submit('longkey', { key: 'x'.repeat(256) }).expect(400);
      expect(response.body.detail).toMatch(/255 characters or fewer/i);
    });

    it('treats a blank key as absent rather than failing', async () => {
      await request(app.getHttpServer())
        .post('/applications')
        .set('Idempotency-Key', '   ')
        .field('jobId', jobId)
        .field('fullName', 'Blank Key')
        .field('email', `blank.${suffix}@test.local`)
        .attach('resume', pdf, { filename: 'resume.pdf', contentType: 'application/pdf' })
        .expect(201);
    });

    /**
     * Two simultaneous requests with one key — the browser double-submit this
     * header exists to defend against. The reservation is a single Redis SET
     * NX, so exactly one can win.
     */
    it('concurrent requests with one key create exactly ONE application', async () => {
      const key = newKey();

      const results = await Promise.all([
        submit('concurrent', { key }),
        submit('concurrent', { key }),
      ]);

      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([201, 409]);

      const effects = await sideEffects('concurrent');
      expect(effects.applications).toBe(1);
      expect(effects.audits).toBe(1);
    });
  });
});
