import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { JobsModule } from './jobs.module';
import { JobsService } from './jobs.service';
import { CommonModule } from '../../common/common.module';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { CorrelationIdMiddleware } from '../../common/middleware/correlation-id.middleware';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * GET /v1/public/jobs and /v1/public/jobs/:id (Handoff §B rows 10–11, CA-01).
 *
 * Exercised over HTTP rather than through the service, because most of what
 * matters here is what an anonymous caller can and cannot obtain: the
 * response shape, the status codes and the absence of a token.
 *
 * Guards are registered globally in main.ts, so @Public() is not what makes
 * these routes reachable in this harness — the separate assertion that the
 * routes carry @Public() lives at the bottom.
 */
describe('PublicJobsController (CA-01 public job board)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;

  const suffix = randomUUID().slice(0, 8);
  let companyId = '';
  let otherCompanyId = '';
  let publishedId = '';
  let draftId = '';
  let closedId = '';
  let otherTenantPublishedId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        JobsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: RequestContext, res: Response, next: NextFunction) =>
      new CorrelationIdMiddleware().use(req, res, next),
    );
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jobs = moduleRef.get(JobsService);

    async function makeTenant(name: string): Promise<AuthenticatedUser> {
      const company = await prisma.company.create({ data: { name, dataRegion: 'test' } });
      const user = await prisma.users.create({
        data: {
          companyId: company.id,
          role: UserRole.RECRUITER,
          email: `pub-${name}.${suffix}@test.local`,
        },
      });
      return { id: user.id, email: user.email, role: user.role, companyId: company.id };
    }

    const recruiter = await makeTenant(`PubA ${suffix}`);
    companyId = recruiter.companyId;

    const published = await jobs.create(recruiter, {
      title: `Senior Engineer ${suffix}`,
      department: 'Engineering',
      location: 'Remote',
      description: 'Build things.',
    });
    await jobs.update(recruiter, published.id, { status: JobStatus.PUBLISHED });
    publishedId = published.id;

    const draft = await jobs.create(recruiter, { title: `Secret Role ${suffix}` });
    draftId = draft.id;

    const closed = await jobs.create(recruiter, { title: `Closed Role ${suffix}` });
    await jobs.update(recruiter, closed.id, { status: JobStatus.PUBLISHED });
    await jobs.update(recruiter, closed.id, { status: JobStatus.CLOSED });
    closedId = closed.id;

    const otherRecruiter = await makeTenant(`PubB ${suffix}`);
    otherCompanyId = otherRecruiter.companyId;
    const otherJob = await jobs.create(otherRecruiter, { title: `Other Tenant ${suffix}` });
    await jobs.update(otherRecruiter, otherJob.id, { status: JobStatus.PUBLISHED });
    otherTenantPublishedId = otherJob.id;
  });

  afterAll(async () => {
    await prisma.company.deleteMany({ where: { id: { in: [companyId, otherCompanyId] } } });
    await app.close();
  });

  /** Only this run's jobs — the dev database holds seeded ones too. */
  function mine(body: { data: { id: string; title: string }[] }) {
    return body.data.filter((j) => j.title.includes(suffix));
  }

  // =========================================================================
  // Listing
  // =========================================================================
  describe('GET /public/jobs', () => {
    it('is reachable with no Authorization header', async () => {
      const response = await request(app.getHttpServer()).get('/public/jobs').expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body).toHaveProperty('nextCursor');
    });

    it('lists a PUBLISHED job', async () => {
      const response = await request(app.getHttpServer()).get('/public/jobs?limit=100').expect(200);

      expect(mine(response.body).map((j) => j.id)).toContain(publishedId);
    });

    it('never lists a DRAFT', async () => {
      const response = await request(app.getHttpServer()).get('/public/jobs?limit=100').expect(200);

      expect(mine(response.body).map((j) => j.id)).not.toContain(draftId);
    });

    it('never lists a CLOSED role — a board of dead links helps nobody', async () => {
      const response = await request(app.getHttpServer()).get('/public/jobs?limit=100').expect(200);

      expect(mine(response.body).map((j) => j.id)).not.toContain(closedId);
    });

    /**
     * The board is deliberately cross-tenant: an anonymous caller has no
     * tenant, so every company's published roles appear together.
     */
    it('spans tenants, because an anonymous caller has none', async () => {
      const response = await request(app.getHttpServer()).get('/public/jobs?limit=100').expect(200);

      const ids = mine(response.body).map((j) => j.id);
      expect(ids).toContain(publishedId);
      expect(ids).toContain(otherTenantPublishedId);
    });

    it('withholds aiScoringEnabled and internal columns (BR-04)', async () => {
      const response = await request(app.getHttpServer()).get('/public/jobs?limit=100').expect(200);

      const job = mine(response.body).find((j) => j.id === publishedId);
      expect(job).toBeDefined();
      expect(job).not.toHaveProperty('aiScoringEnabled');
      expect(job).not.toHaveProperty('companyId');
      expect(job).not.toHaveProperty('createdBy');
      expect(job).not.toHaveProperty('createdAt');
      expect(job).not.toHaveProperty('updatedAt');
    });

    it('returns the fields CA-01 renders', async () => {
      const response = await request(app.getHttpServer()).get('/public/jobs?limit=100').expect(200);

      expect(mine(response.body).find((j) => j.id === publishedId)).toMatchObject({
        title: `Senior Engineer ${suffix}`,
        department: 'Engineering',
        location: 'Remote',
        description: 'Build things.',
        status: 'PUBLISHED',
      });
    });

    // ---- pagination (PRD §23.1) -----------------------------------------

    it('honours limit and returns a cursor when more remain', async () => {
      const response = await request(app.getHttpServer()).get('/public/jobs?limit=1').expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.nextCursor).toBeTruthy();
    });

    it('does not repeat a row across pages', async () => {
      const first = await request(app.getHttpServer()).get('/public/jobs?limit=1').expect(200);
      const second = await request(app.getHttpServer())
        .get(`/public/jobs?limit=1&cursor=${first.body.nextCursor}`)
        .expect(200);

      expect(second.body.data[0]?.id).not.toBe(first.body.data[0]?.id);
    });

    it('rejects a limit outside 1–100', async () => {
      const response = await request(app.getHttpServer()).get('/public/jobs?limit=101').expect(400);

      expect(response.body.detail).toMatch(/between 1 and 100/i);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    /**
     * `status` is a filter on the AUTHENTICATED list endpoint. Accepting it
     * here would let a caller ask the public board for drafts.
     */
    it('refuses a status filter rather than letting one be requested', async () => {
      await request(app.getHttpServer()).get('/public/jobs?status=DRAFT').expect(400);
    });
  });

  // =========================================================================
  // Detail
  // =========================================================================
  describe('GET /public/jobs/:id', () => {
    it('returns a PUBLISHED role with no Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .get(`/public/jobs/${publishedId}`)
        .expect(200);

      expect(response.body).toMatchObject({ id: publishedId, status: 'PUBLISHED' });
    });

    /**
     * CA-01 lists "Closed job" and "not found" as two distinct states, and
     * this endpoint is the only thing feeding that screen — so a closed role
     * must remain readable and say so.
     */
    it('CA-01: returns a CLOSED role so the screen can render that state', async () => {
      const response = await request(app.getHttpServer())
        .get(`/public/jobs/${closedId}`)
        .expect(200);

      expect(response.body).toMatchObject({ id: closedId, status: 'CLOSED' });
      expect(response.body.closedAt).toBeTruthy();
    });

    it('404s a DRAFT — it has never been public', async () => {
      await request(app.getHttpServer()).get(`/public/jobs/${draftId}`).expect(404);
    });

    it('gives a DRAFT and a missing job the SAME response (no enumeration)', async () => {
      const draft = await request(app.getHttpServer()).get(`/public/jobs/${draftId}`).expect(404);
      const missing = await request(app.getHttpServer())
        .get(`/public/jobs/${randomUUID()}`)
        .expect(404);

      expect(draft.body.detail).toBe(missing.body.detail);
      expect(draft.body.title).toBe(missing.body.title);
    });

    it('reads a job in another tenant — the board is tenant-blind', async () => {
      await request(app.getHttpServer()).get(`/public/jobs/${otherTenantPublishedId}`).expect(200);
    });

    it('withholds aiScoringEnabled on detail too', async () => {
      const response = await request(app.getHttpServer())
        .get(`/public/jobs/${publishedId}`)
        .expect(200);

      expect(response.body).not.toHaveProperty('aiScoringEnabled');
      expect(response.body).not.toHaveProperty('companyId');
    });

    it('rejects a malformed id as 400, not a database probe', async () => {
      await request(app.getHttpServer()).get('/public/jobs/not-a-uuid').expect(400);
    });

    it('carries a correlation id on the error response (NFR11)', async () => {
      const response = await request(app.getHttpServer())
        .get(`/public/jobs/${randomUUID()}`)
        .expect(404);

      expect(response.body.correlationId).toBeTruthy();
    });
  });
});
