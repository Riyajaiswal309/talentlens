import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { JobStatus, ParseStatus, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApplicationsService, toApplicationAuditSnapshot } from './applications.service';
import { MAX_RESUME_BYTES } from './resume-file';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  PassThroughScanner,
  ResumeScanner,
  type ScanResult,
} from '../../common/storage/resume-scanner';
import { StorageService } from '../../common/storage/storage.service';
import {
  RESUME_QUEUE,
  RESUME_UPLOADED,
  ResumeQueueService,
  type ResumeUploadedEvent,
} from '../../common/queue/resume-queue.service';
import { JobsService } from '../jobs/jobs.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';

/**
 * ApplicationsService integration tests — require the M2.2 database AND
 * LocalStack (`docker compose up -d`).
 *
 * Storage is exercised against real S3 rather than a mock. The point of
 * approving LocalStack (decision A1) was that the S3 code path is executed in
 * development; asserting against a stub would give that up and leave the only
 * untested implementation running in production.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:4566';
const S3_BUCKET = process.env.S3_BUCKET ?? 'talentlens-resumes-dev';

const storageConfig = {
  get: (key: string) =>
    ({
      S3_ENDPOINT,
      S3_BUCKET,
      S3_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    })[key],
} as unknown as ConfigService;

/** A minimally valid PDF: correct magic bytes and non-zero length. */
function pdfFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  const buffer = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  return {
    fieldname: 'resume',
    originalname: 'resume.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: buffer.length,
    buffer,
    ...overrides,
  } as Express.Multer.File;
}

/** DOCX is an OOXML zip, so it opens with the ZIP local file header. */
function docxFile(): Express.Multer.File {
  const buffer = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/')]);
  return {
    fieldname: 'resume',
    originalname: 'resume.docx',
    encoding: '7bit',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
}

/** Scanner that condemns everything — stands in for a real detection. */
class RejectingScanner extends ResumeScanner {
  scan(): Promise<ScanResult> {
    return Promise.resolve({ clean: false, signature: 'Test.Signature' });
  }
}

describe('ApplicationsService (FR2.1 public intake + resume upload)', () => {
  let prisma: PrismaService;
  let storage: StorageService;
  let service: ApplicationsService;
  let jobs: JobsService;
  let s3: S3Client;
  let queue: ResumeQueueService;
  let publish: jest.SpyInstance;

  const suffix = randomUUID().slice(0, 8);
  /** NFR11 — one id that must reach the queue job unchanged. */
  const CORRELATION = `corr-${randomUUID()}`;
  let companyId = '';
  let recruiter: AuthenticatedUser;
  let publishedJobId = '';
  let draftJobId = '';
  let closedJobId = '';

  /** True when the object really exists in the bucket. */
  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    prisma = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await prisma.$connect();

    storage = new StorageService(storageConfig);
    queue = new ResumeQueueService({
      get: () => process.env.REDIS_URL ?? 'redis://localhost:6379',
    } as unknown as ConfigService);
    service = new ApplicationsService(prisma, storage, new PassThroughScanner(), queue);
    jobs = new JobsService(prisma);

    s3 = new S3Client({
      region: 'us-east-1',
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });

    const company = await prisma.company.create({
      data: { name: `Apps ${suffix}`, dataRegion: 'test' },
    });
    companyId = company.id;

    const u = await prisma.users.create({
      data: {
        companyId,
        role: UserRole.RECRUITER,
        email: `apps-rec.${suffix}@test.local`,
      },
    });
    recruiter = { id: u.id, email: u.email, role: u.role, companyId: u.companyId };

    const published = await jobs.create(recruiter, { title: `Published ${suffix}` });
    await jobs.update(recruiter, published.id, { status: JobStatus.PUBLISHED });
    publishedJobId = published.id;

    const draft = await jobs.create(recruiter, { title: `Draft ${suffix}` });
    draftJobId = draft.id;

    const closed = await jobs.create(recruiter, { title: `Closed ${suffix}` });
    await jobs.update(recruiter, closed.id, { status: JobStatus.PUBLISHED });
    await jobs.update(recruiter, closed.id, { status: JobStatus.CLOSED });
    closedJobId = closed.id;
  });

  afterAll(async () => {
    // Companies cascade to jobs and applications; candidates are separate
    // (applications.candidate_id is RESTRICT) so they go afterwards.
    await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.candidate.deleteMany({ where: { email: { contains: suffix } } });
    // Remove the objects this run uploaded, so the dev bucket does not grow
    // by a few dozen files every time the suite is executed.
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `resumes/${companyId}/` }),
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key) {
        await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: object.Key }));
      }
    }

    // Drop the jobs this run enqueued. Matched on correlation id so a shared
    // dev Redis is never drained of anything that is not ours.
    for (const job of await queue.getQueue().getJobs(['waiting', 'delayed', 'failed'])) {
      if ((job.data as ResumeUploadedEvent)?.correlationId?.startsWith('corr-')) {
        await job.remove();
      }
    }

    await queue.onModuleDestroy();
    await prisma.$disconnect();
    s3.destroy();
  });

  beforeEach(() => {
    // Spied, not stubbed: the call still reaches Redis, so the publication
    // tests below assert against a real queue rather than a fake.
    publish = jest.spyOn(queue, 'publishResumeUploaded');
  });

  afterEach(() => {
    publish.mockRestore();
  });

  const validSubmission = () => ({
    jobId: publishedJobId,
    fullName: 'Ada Lovelace',
    email: `ada.${suffix}@test.local`,
    phone: '+91 90000 00000',
  });

  // =========================================================================
  // Happy path
  // =========================================================================
  describe('successful submission', () => {
    it('creates a candidate, an application and a resume together', async () => {
      const result = await service.submit(validSubmission(), pdfFile(), CORRELATION);

      expect(result.application.id).toBeTruthy();
      expect(result.candidate.id).toBeTruthy();
      expect(result.application.candidateId).toBe(result.candidate.id);
      expect(result.application.jobId).toBe(publishedJobId);
      expect(result.resume.applicationId).toBe(result.application.id);
    });

    it('normalises the email to lowercase and trims the name', async () => {
      const result = await service.submit(
        {
          jobId: publishedJobId,
          fullName: '  Grace Hopper  ',
          email: `  MiXeD.${suffix}@TEST.local  `,
        },
        pdfFile(),
        CORRELATION,
      );

      expect(result.candidate.fullName).toBe('Grace Hopper');
      expect(result.candidate.email).toBe(`mixed.${suffix}@test.local`);
    });

    it('leaves phone null when omitted', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'No Phone', email: `nophone.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      expect(result.candidate.phone).toBeNull();
    });

    /**
     * Approved candidate-identity resolution, rule 1: a profile may exist
     * without a login account. A public applicant has none.
     */
    it('creates the candidate with no linked user account', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'Anonymous', email: `anon.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      expect(result.candidate.userId).toBeNull();
    });

    it('places the applicant in the job own first stage, not a hard-coded one', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'Stage Check', email: `stage.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      const firstStage = await prisma.pipelineStage.findFirst({
        where: { jobId: publishedJobId },
        orderBy: { position: 'asc' },
      });

      expect(result.application.currentStage).toBe(firstStage?.name);
      expect(result.application.currentStage).toBe('Applied');
    });

    /**
     * Decision B2 makes stages per-job configurable, so the opening stage must
     * follow the job rather than a constant.
     */
    it('B2: follows a RENAMED first stage', async () => {
      const custom = await jobs.create(recruiter, { title: `Renamed ${suffix}` });
      await jobs.update(recruiter, custom.id, { status: JobStatus.PUBLISHED });

      await prisma.pipelineStage.updateMany({
        where: { jobId: custom.id, position: 1 },
        data: { name: 'Received' },
      });

      const result = await service.submit(
        { jobId: custom.id, fullName: 'Custom Stage', email: `custom.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      expect(result.application.currentStage).toBe('Received');
    });

    it('stamps appliedAt', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'Timestamp', email: `ts.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      expect(result.application.appliedAt).toBeInstanceOf(Date);
    });

    it('accepts a DOCX as well as a PDF (FR3.3)', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'Docx User', email: `docx.${suffix}@test.local` },
        docxFile(),
        CORRELATION,
      );

      expect(result.resume.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(result.resume.s3Key.endsWith('.docx')).toBe(true);
    });
  });

  // =========================================================================
  // Storage (LocalStack S3)
  // =========================================================================
  describe('storage', () => {
    it('really uploads the file to the bucket', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'Uploader', email: `upload.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      await expect(objectExists(result.resume.s3Key)).resolves.toBe(true);
    });

    /**
     * The key is tenant-prefixed so a bucket policy or lifecycle rule can be
     * scoped per company later without rewriting existing keys.
     */
    it('prefixes the key with the company that owns the job', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'Key Shape', email: `key.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      expect(result.resume.s3Key.startsWith(`resumes/${companyId}/`)).toBe(true);
    });

    it('does not put the uploaded filename in the key', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'Private', email: `private.${suffix}@test.local` },
        pdfFile({ originalname: 'ada-lovelace-cv-CONFIDENTIAL.pdf' }),
        CORRELATION,
      );

      expect(result.resume.s3Key).not.toContain('CONFIDENTIAL');
      expect(result.resume.s3Key).not.toContain('ada-lovelace');
    });

    it('gives two submissions of the same file different keys', async () => {
      const a = await service.submit(
        { jobId: publishedJobId, fullName: 'One', email: `one.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );
      const b = await service.submit(
        { jobId: publishedJobId, fullName: 'Two', email: `two.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      expect(a.resume.s3Key).not.toBe(b.resume.s3Key);
    });

    it('FR2.5: leaves parse_status PENDING — nothing parses in Phase 2', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'Pending', email: `pending.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      expect(result.resume.parseStatus).toBe(ParseStatus.PENDING);

      const parsed = await prisma.parsedProfile.findUnique({
        where: { resumeId: result.resume.id },
      });
      expect(parsed).toBeNull();
    });

    /**
     * A storage outage must not produce an application row pointing at a file
     * that was never written.
     */
    it('creates NO rows when the upload fails', async () => {
      const failing = new StorageService(storageConfig);
      jest.spyOn(failing, 'put').mockRejectedValue(new Error('S3 unavailable'));
      const failingService = new ApplicationsService(
        prisma,
        failing,
        new PassThroughScanner(),
        queue,
      );

      const email = `s3fail.${suffix}@test.local`;
      await expect(
        failingService.submit(
          { jobId: publishedJobId, fullName: 'S3 Down', email },
          pdfFile(),
          CORRELATION,
        ),
      ).rejects.toThrow('S3 unavailable');

      await expect(prisma.candidate.findFirst({ where: { email } })).resolves.toBeNull();
    });

    /**
     * The reverse failure: the file was stored, then the transaction failed.
     * The object must be removed rather than left orphaned in the bucket.
     */
    it('deletes the uploaded object when the transaction fails', async () => {
      const spyStorage = new StorageService(storageConfig);
      let storedKey = '';
      const realPut = spyStorage.put.bind(spyStorage);
      jest.spyOn(spyStorage, 'put').mockImplementation(async (key, body, type) => {
        storedKey = key;
        await realPut(key, body, type);
      });

      /*
       * A purpose-built stub, NOT a clone of the real client. PrismaClient is
       * a Proxy, so assigning $transaction onto an Object.create() of it
       * writes straight through to the shared instance and breaks every later
       * test in this file.
       */
      const brokenPrisma = {
        job: { findUnique: (args: unknown) => prisma.job.findUnique(args as never) },
        $transaction: jest.fn().mockRejectedValue(new Error('deadlock detected')),
      } as unknown as PrismaService;
      const brokenService = new ApplicationsService(
        brokenPrisma,
        spyStorage,
        new PassThroughScanner(),
        queue,
      );

      await expect(
        brokenService.submit(
          { jobId: publishedJobId, fullName: 'Orphan', email: `orphan2.${suffix}@test.local` },
          pdfFile(),
          CORRELATION,
        ),
      ).rejects.toThrow('deadlock detected');

      expect(storedKey).not.toBe('');
      await expect(objectExists(storedKey)).resolves.toBe(false);
    });
  });

  // =========================================================================
  // resume.uploaded publication (PRD §23.1, Phase 1 Flow 3 step 4)
  // =========================================================================
  describe('resume.uploaded event', () => {
    const queued = (email: string) => ({
      jobId: publishedJobId,
      fullName: 'Queue User',
      email: `${email}.${suffix}@test.local`,
    });

    it('publishes exactly one event for a successful submission', async () => {
      const result = await service.submit(queued('q1'), pdfFile(), CORRELATION);

      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith({
        resumeId: result.resume.id,
        correlationId: CORRELATION,
      });
    });

    /**
     * NFR11 / PRD §25 — the correlation id must survive into the queue so a
     * worker's logs join up with the HTTP request that created the job.
     */
    it('carries the correlation id of the originating request', async () => {
      const distinct = `corr-${randomUUID()}`;
      await service.submit(queued('q2'), pdfFile(), distinct);

      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ correlationId: distinct }));
    });

    /** The job really lands in Redis, with the payload a consumer will read. */
    it('really enqueues the job in BullMQ', async () => {
      const result = await service.submit(queued('q3'), pdfFile(), CORRELATION);

      const job = await queue.getQueue().getJob(result.resume.id);

      expect(job).toBeDefined();
      expect(job?.name).toBe(RESUME_UPLOADED);
      expect(job?.data).toEqual({ resumeId: result.resume.id, correlationId: CORRELATION });
      expect(job?.queueName).toBe(RESUME_QUEUE);

      await job?.remove();
    });

    /**
     * The ordering the PRD fixes: the rows must be committed before the event
     * exists, or a consumer resolving the resume by id races the transaction
     * and finds nothing.
     */
    it('publishes only AFTER the transaction has committed', async () => {
      const order: string[] = [];

      const orderedQueue = new ResumeQueueService({
        get: () => process.env.REDIS_URL ?? 'redis://localhost:6379',
      } as unknown as ConfigService);
      jest
        .spyOn(orderedQueue, 'publishResumeUploaded')
        .mockImplementation(async (event: ResumeUploadedEvent) => {
          // Read through a SEPARATE connection at publish time: if the event
          // were published inside the transaction, this row would not yet be
          // visible and the assertion below would fail.
          const row = await prisma.resume.findUnique({ where: { id: event.resumeId } });
          order.push(row ? 'committed-then-published' : 'published-before-commit');
        });

      const svc = new ApplicationsService(prisma, storage, new PassThroughScanner(), orderedQueue);
      await svc.submit(queued('q4'), pdfFile(), CORRELATION);

      expect(order).toEqual(['committed-then-published']);
      await orderedQueue.onModuleDestroy();
    });

    it('publishes AFTER the file is stored, never before', async () => {
      const order: string[] = [];

      const spyStorage = new StorageService(storageConfig);
      jest.spyOn(spyStorage, 'put').mockImplementation(() => {
        order.push('stored');
        return Promise.resolve();
      });

      const spyQueue = new ResumeQueueService({
        get: () => process.env.REDIS_URL ?? 'redis://localhost:6379',
      } as unknown as ConfigService);
      jest.spyOn(spyQueue, 'publishResumeUploaded').mockImplementation(() => {
        order.push('published');
        return Promise.resolve();
      });

      const svc = new ApplicationsService(prisma, spyStorage, new PassThroughScanner(), spyQueue);
      await svc.submit(queued('q5'), pdfFile(), CORRELATION);

      expect(order).toEqual(['stored', 'published']);
      await spyQueue.onModuleDestroy();
    });

    // ---- nothing rejected is ever announced ------------------------------

    it('does NOT publish when the scanner condemns the file', async () => {
      const svc = new ApplicationsService(prisma, storage, new RejectingScanner(), queue);

      await expect(svc.submit(queued('q6'), pdfFile(), CORRELATION)).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
    });

    it('does NOT publish when validation fails', async () => {
      await expect(
        service.submit(queued('q7'), pdfFile({ mimetype: 'image/png' }), CORRELATION),
      ).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
    });

    it('does NOT publish when no file was attached', async () => {
      await expect(service.submit(queued('q8'), undefined, CORRELATION)).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
    });

    it('does NOT publish when the job is unavailable', async () => {
      await expect(
        service.submit(
          { jobId: closedJobId, fullName: 'Closed', email: `q9.${suffix}@test.local` },
          pdfFile(),
          CORRELATION,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(publish).not.toHaveBeenCalled();
    });

    it('does NOT publish when the upload to S3 fails', async () => {
      const failing = new StorageService(storageConfig);
      jest.spyOn(failing, 'put').mockRejectedValue(new Error('S3 unavailable'));
      const svc = new ApplicationsService(prisma, failing, new PassThroughScanner(), queue);

      await expect(svc.submit(queued('q10'), pdfFile(), CORRELATION)).rejects.toThrow(
        'S3 unavailable',
      );
      expect(publish).not.toHaveBeenCalled();
    });

    it('does NOT publish when the transaction fails', async () => {
      const brokenPrisma = {
        job: { findUnique: (args: unknown) => prisma.job.findUnique(args as never) },
        $transaction: jest.fn().mockRejectedValue(new Error('deadlock detected')),
      } as unknown as PrismaService;

      const svc = new ApplicationsService(
        brokenPrisma,
        new StorageService(storageConfig),
        new PassThroughScanner(),
        queue,
      );

      await expect(svc.submit(queued('q11'), pdfFile(), CORRELATION)).rejects.toThrow(
        'deadlock detected',
      );
      expect(publish).not.toHaveBeenCalled();
    });

    /**
     * FR2.5 makes intake independent of parsing, and PRD §20 keeps the
     * application valid when parsing does not happen. Losing a completed
     * application because Redis blinked would be the worse failure, so the
     * submission stands and the resume stays PENDING for recovery.
     */
    it('still succeeds when the queue is down, leaving the resume PENDING', async () => {
      const deadQueue = new ResumeQueueService({
        get: () => 'redis://localhost:6379',
      } as unknown as ConfigService);
      jest
        .spyOn(deadQueue, 'publishResumeUploaded')
        .mockRejectedValue(new Error('ECONNREFUSED redis'));

      const svc = new ApplicationsService(prisma, storage, new PassThroughScanner(), deadQueue);
      const result = await svc.submit(queued('q12'), pdfFile(), CORRELATION);

      expect(result.application.id).toBeTruthy();
      expect(result.resume.parseStatus).toBe(ParseStatus.PENDING);

      // The application and its file are intact — only the announcement was lost.
      await expect(objectExists(result.resume.s3Key)).resolves.toBe(true);
      await expect(
        prisma.application.findUnique({ where: { id: result.application.id } }),
      ).resolves.not.toBeNull();

      await deadQueue.onModuleDestroy();
    });
  });

  // =========================================================================
  // FR2.5 — "Application submission succeeds and returns confirmation
  // regardless of parsing outcome; parsing failure never blocks intake."
  //
  // Phase 1 gives this one acceptance criterion for Phase 2: "201 returned
  // before parse completes". These tests pin the guarantee against the
  // failure mode Phase 3 will introduce, so a future parser cannot quietly
  // make intake depend on it.
  // =========================================================================
  describe('FR2.5 — intake is independent of parsing', () => {
    const fr25 = (email: string) => ({
      jobId: publishedJobId,
      fullName: 'Parse Independent',
      email: `${email}.${suffix}@test.local`,
    });

    it('a complete application exists with no parsed profile at all', async () => {
      const result = await service.submit(fr25('fr25a'), pdfFile(), CORRELATION);

      const stored = await prisma.application.findUnique({
        where: { id: result.application.id },
        include: { resume: { include: { parsedProfile: true } }, candidate: true },
      });

      expect(stored?.resume?.parsedProfile).toBeNull();
      // Everything a recruiter needs to act on is present regardless.
      expect(stored?.currentStage).toBe('Applied');
      expect(stored?.candidate.fullName).toBe('Parse Independent');
      expect(stored?.resume?.s3Key).toBeTruthy();
    });

    /**
     * The core FR2.5 claim, exercised directly: a FAILED parse must leave the
     * application valid. Phase 2 has no parser, so the status is set here to
     * stand in for the Phase 3 failure.
     */
    it('a FAILED parse leaves the application valid and in its stage', async () => {
      const result = await service.submit(fr25('fr25b'), pdfFile(), CORRELATION);

      await prisma.resume.update({
        where: { id: result.resume.id },
        data: { parseStatus: ParseStatus.FAILED },
      });

      const stored = await prisma.application.findUnique({
        where: { id: result.application.id },
        include: { resume: true },
      });

      expect(stored).not.toBeNull();
      expect(stored?.currentStage).toBe('Applied');
      expect(stored?.resume?.parseStatus).toBe(ParseStatus.FAILED);
      // The file is still there to be read manually or re-parsed later.
      await expect(objectExists(result.resume.s3Key)).resolves.toBe(true);
    });

    /**
     * CA-04: the confirmation "must render even if parsing incomplete". It
     * therefore must not depend on any parsed value.
     */
    it('the confirmation payload contains nothing parse-dependent', async () => {
      const result = await service.submit(fr25('fr25c'), pdfFile(), CORRELATION);

      expect(result.application.appliedAt).toBeInstanceOf(Date);
      expect(result.application.currentStage).toBeTruthy();
      expect(result.job.title).toBeTruthy();
      expect(result.resume.parseStatus).toBe(ParseStatus.PENDING);
    });

    /**
     * Handoff Gap 3: "The `parsed_profiles` table IS created in Phase 2 so the
     * candidate manual-entry path (FR2.5) has storage." That storage
     * obligation is what this asserts — the write path a manual-entry feature
     * would use exists and holds, one profile per resume.
     */
    it('parsed_profiles is ready to receive manually entered data', async () => {
      const result = await service.submit(fr25('fr25d'), pdfFile(), CORRELATION);

      const profile = await prisma.parsedProfile.create({
        data: {
          resumeId: result.resume.id,
          skills: ['TypeScript', 'PostgreSQL'],
          workHistory: [{ company: 'Self-entered', title: 'Engineer' }],
          education: [],
          certifications: [],
          // No parser ran, so there is no model confidence to record.
          confidenceScore: null,
        },
      });

      const readBack = await prisma.resume.findUnique({
        where: { id: result.resume.id },
        include: { parsedProfile: true },
      });

      expect(readBack?.parsedProfile?.id).toBe(profile.id);
      expect(readBack?.parsedProfile?.skills).toEqual(['TypeScript', 'PostgreSQL']);
      expect(readBack?.parsedProfile?.confidenceScore).toBeNull();

      // One profile per resume — a second write for the same resume conflicts
      // rather than silently creating a duplicate history.
      await expect(
        prisma.parsedProfile.create({
          data: { resumeId: result.resume.id, skills: [], workHistory: [] },
        }),
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // File validation (§20 stage 1, first half)
  // =========================================================================
  describe('file validation', () => {
    const submission = (email: string) => ({
      jobId: publishedJobId,
      fullName: 'Validator',
      email: `${email}.${suffix}@test.local`,
    });

    it('requires a resume — FR2.1 is "apply via resume upload"', async () => {
      await expect(service.submit(submission('nofile'), undefined, CORRELATION)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an empty file', async () => {
      const empty = pdfFile({ buffer: Buffer.alloc(0), size: 0 });
      await expect(service.submit(submission('empty'), empty, CORRELATION)).rejects.toThrow(
        /file is empty/i,
      );
    });

    it('rejects a type that is neither PDF nor DOCX', async () => {
      const png = pdfFile({ mimetype: 'image/png', originalname: 'photo.png' });
      await expect(service.submit(submission('png'), png, CORRELATION)).rejects.toThrow(
        /PDF or DOCX/i,
      );
    });

    /**
     * The declared Content-Type is attacker-controlled. Without a magic-byte
     * check, any payload could be stored as "application/pdf" and later handed
     * to the Phase 3 parser.
     */
    it('rejects a file whose CONTENT does not match its declared type', async () => {
      const liar = pdfFile({
        buffer: Buffer.from('#!/bin/sh\nrm -rf /\n'),
        mimetype: 'application/pdf',
        originalname: 'resume.pdf',
      });
      liar.size = liar.buffer.length;

      await expect(service.submit(submission('liar'), liar, CORRELATION)).rejects.toThrow(
        /not a valid PDF or DOCX/i,
      );
    });

    it('rejects a DOCX mime carrying PDF content', async () => {
      const mismatch = pdfFile({
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      await expect(service.submit(submission('mismatch'), mismatch, CORRELATION)).rejects.toThrow(
        /not a valid PDF or DOCX/i,
      );
    });

    it('decision C: rejects a file over 10 MB', async () => {
      const big = pdfFile({ size: MAX_RESUME_BYTES + 1 });
      await expect(service.submit(submission('big'), big, CORRELATION)).rejects.toThrow(
        PayloadTooLargeException,
      );
    });

    it('accepts a file exactly at the 10 MB limit', () => {
      // Boundary check on the rule itself; the service test above would need a
      // 10 MB buffer round-tripped to S3 to assert the same thing.
      expect(MAX_RESUME_BYTES).toBe(10 * 1024 * 1024);
    });

    it('stores nothing when validation fails', async () => {
      const png = pdfFile({ mimetype: 'image/png' });
      const spyStorage = new StorageService(storageConfig);
      const put = jest.spyOn(spyStorage, 'put');
      const svc = new ApplicationsService(prisma, spyStorage, new PassThroughScanner(), queue);

      await expect(svc.submit(submission('novalidput'), png, CORRELATION)).rejects.toThrow();
      expect(put).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Antivirus boundary (PRD §20 stage 1, decision B1)
  // =========================================================================
  describe('antivirus scan', () => {
    const scanSubmission = (email: string) => ({
      jobId: publishedJobId,
      fullName: 'Infected',
      email: `${email}.${suffix}@test.local`,
    });

    it('rejects a file the scanner condemns', async () => {
      const svc = new ApplicationsService(prisma, storage, new RejectingScanner(), queue);

      await expect(svc.submit(scanSubmission('av1'), pdfFile(), CORRELATION)).rejects.toThrow(
        /failed our security scan/i,
      );
    });

    /** The whole point of the ordering: a condemned file never reaches S3. */
    it('does NOT store a condemned file', async () => {
      const spyStorage = new StorageService(storageConfig);
      const put = jest.spyOn(spyStorage, 'put');
      const svc = new ApplicationsService(prisma, spyStorage, new RejectingScanner(), queue);

      await expect(svc.submit(scanSubmission('av2'), pdfFile(), CORRELATION)).rejects.toThrow();
      expect(put).not.toHaveBeenCalled();
    });

    it('creates no candidate or application for a condemned file', async () => {
      const email = `av3.${suffix}@test.local`;
      const svc = new ApplicationsService(prisma, storage, new RejectingScanner(), queue);

      await svc
        .submit({ jobId: publishedJobId, fullName: 'Infected', email }, pdfFile(), CORRELATION)
        .catch(() => undefined);

      await expect(prisma.candidate.findFirst({ where: { email } })).resolves.toBeNull();
    });

    it('does not leak the signature name to the applicant', async () => {
      const svc = new ApplicationsService(prisma, storage, new RejectingScanner(), queue);

      const message = await svc
        .submit(scanSubmission('av4'), pdfFile(), CORRELATION)
        .then(() => '')
        .catch((e: Error) => e.message);

      expect(message).not.toContain('Test.Signature');
    });

    /**
     * PRD §20 stage 1 orders the scan BEFORE persistence. Asserted on call
     * order directly, because a future refactor that stored first would
     * otherwise still pass every other test here.
     */
    it('PRD §20: scans BEFORE it stores', async () => {
      const order: string[] = [];
      const spyStorage = new StorageService(storageConfig);
      jest.spyOn(spyStorage, 'put').mockImplementation(() => {
        order.push('stored');
        return Promise.resolve();
      });

      const recordingScanner = new (class extends ResumeScanner {
        scan(): Promise<ScanResult> {
          order.push('scanned');
          return Promise.resolve({ clean: true });
        }
      })();

      const svc = new ApplicationsService(prisma, spyStorage, recordingScanner, queue);
      await svc.submit(
        { jobId: publishedJobId, fullName: 'Order', email: `order.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      expect(order).toEqual(['scanned', 'stored']);
    });

    it('the pass-through scanner still catches the EICAR test file', async () => {
      const eicar = pdfFile();
      eicar.buffer = Buffer.concat([
        Buffer.from('%PDF-1.4\n'),
        Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
      ]);
      eicar.size = eicar.buffer.length;

      await expect(service.submit(scanSubmission('eicar'), eicar, CORRELATION)).rejects.toThrow(
        /failed our security scan/i,
      );
    });

    it('passes an ordinary file', async () => {
      const clean = await new PassThroughScanner().scan(pdfFile().buffer, 'resume.pdf');
      expect(clean.clean).toBe(true);
    });
  });

  // =========================================================================
  // Job validation
  // =========================================================================
  describe('job validation', () => {
    it('refuses a DRAFT job', async () => {
      await expect(
        service.submit(
          { jobId: draftJobId, fullName: 'Too Early', email: `early.${suffix}@test.local` },
          pdfFile(),
          CORRELATION,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a CLOSED job', async () => {
      await expect(
        service.submit(
          { jobId: closedJobId, fullName: 'Too Late', email: `late.${suffix}@test.local` },
          pdfFile(),
          CORRELATION,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a job that does not exist', async () => {
      await expect(
        service.submit(
          { jobId: randomUUID(), fullName: 'Nowhere', email: `nowhere.${suffix}@test.local` },
          pdfFile(),
          CORRELATION,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    /**
     * A public endpoint must not disclose which unpublished requisitions
     * exist, so all three refusals carry identical wording.
     */
    it('gives the SAME message for draft, closed and missing (no disclosure)', async () => {
      const messages = await Promise.all(
        [draftJobId, closedJobId, randomUUID()].map((jobId) =>
          service
            .submit(
              { jobId, fullName: 'X', email: `x.${suffix}@test.local` },
              pdfFile(),
              CORRELATION,
            )
            .catch((e: Error) => e.message),
        ),
      );

      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toBe('This role is no longer accepting applications');
    });

    it('creates no candidate row when the job is rejected', async () => {
      const email = `orphan.${suffix}@test.local`;

      await service
        .submit({ jobId: closedJobId, fullName: 'Orphan', email }, pdfFile(), CORRELATION)
        .catch(() => undefined);

      const candidate = await prisma.candidate.findFirst({ where: { email } });
      expect(candidate).toBeNull();
    });

    /** An unavailable job is rejected before the file is even looked at. */
    it('does not store a file for an unavailable job', async () => {
      const spyStorage = new StorageService(storageConfig);
      const put = jest.spyOn(spyStorage, 'put');
      const svc = new ApplicationsService(prisma, spyStorage, new PassThroughScanner(), queue);

      await expect(
        svc.submit(
          { jobId: closedJobId, fullName: 'Closed', email: `closedput.${suffix}@test.local` },
          pdfFile(),
          CORRELATION,
        ),
      ).rejects.toThrow(NotFoundException);

      expect(put).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Tenancy
  // =========================================================================
  describe('tenancy', () => {
    /**
     * A public caller has no principal, so tenancy cannot come from the
     * request. It is derived from the job.
     */
    it('derives the tenant from the job, not from the caller', async () => {
      const result = await service.submit(
        { jobId: publishedJobId, fullName: 'Tenant Check', email: `tenant.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      const job = await prisma.job.findUnique({
        where: { id: result.application.jobId },
        select: { companyId: true },
      });

      expect(job?.companyId).toBe(companyId);
    });

    it('stores another tenant file under that tenant own prefix', async () => {
      const otherCompany = await prisma.company.create({
        data: { name: `Other ${suffix}`, dataRegion: 'test' },
      });
      const otherUser = await prisma.users.create({
        data: {
          companyId: otherCompany.id,
          role: UserRole.RECRUITER,
          email: `other-rec.${suffix}@test.local`,
        },
      });
      const otherRecruiter: AuthenticatedUser = {
        id: otherUser.id,
        email: otherUser.email,
        role: otherUser.role,
        companyId: otherUser.companyId,
      };

      const otherJob = await jobs.create(otherRecruiter, { title: `Other job ${suffix}` });
      await jobs.update(otherRecruiter, otherJob.id, { status: JobStatus.PUBLISHED });

      const result = await service.submit(
        { jobId: otherJob.id, fullName: 'Cross Tenant', email: `cross.${suffix}@test.local` },
        pdfFile(),
        CORRELATION,
      );

      expect(result.resume.s3Key.startsWith(`resumes/${otherCompany.id}/`)).toBe(true);
      expect(result.resume.s3Key).not.toContain(companyId);

      await prisma.company.delete({ where: { id: otherCompany.id } });
    });
  });

  // =========================================================================
  // Audit snapshot
  // =========================================================================
  describe('audit snapshot', () => {
    it('captures the identifiers an auditor needs, including the resume', async () => {
      const result = await service.submit(
        {
          jobId: publishedJobId,
          fullName: 'Audit Shape',
          email: `auditshape.${suffix}@test.local`,
        },
        pdfFile(),
        CORRELATION,
      );

      expect(toApplicationAuditSnapshot(result)).toMatchObject({
        applicationId: result.application.id,
        jobId: publishedJobId,
        candidateId: result.candidate.id,
        currentStage: 'Applied',
        resumeId: result.resume.id,
        resumeKey: result.resume.s3Key,
      });
    });
  });
});
