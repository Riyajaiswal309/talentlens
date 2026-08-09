import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ScorecardsModule } from './scorecards.module';
import { MAX_RATING, MIN_RATING } from './dto/create-scorecard.dto';
import { ApplicationsModule } from '../applications/applications.module';
import { ApplicationsService } from '../applications/applications.service';
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
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';

/**
 * Scorecards — FR5.3, PRD §24.2, Handoff §B row 18.
 *
 * Real guard chain and real access tokens: the role matrix, the Hiring
 * Manager's assigned-jobs restriction and the guarantee that a candidate can
 * never read the team's assessment of them all live end to end.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('Scorecards (FR5.3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobsService;
  let applications: ApplicationsService;
  let tokens: TokenService;

  const suffix = randomUUID().slice(0, 8);
  const CORRELATION = `corr-${randomUUID()}`;
  const userIds: string[] = [];

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

  async function newApplication(tag: string, job = jobAssigned): Promise<string> {
    const result = await applications.submit(
      { jobId: job, fullName: `SC ${tag}`, email: `${tag}.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
    return result.application.id;
  }

  /** `object` rather than a DTO type: several tests deliberately send fields
   *  the DTO forbids, to prove forbidNonWhitelisted rejects them. */
  function submit(id: string, body: object, token: string) {
    return request(app.getHttpServer())
      .post(`/applications/${id}/scorecards`)
      .set(auth(token))
      .send(body);
  }

  function list(id: string, token: string) {
    return request(app.getHttpServer()).get(`/applications/${id}/scorecards`).set(auth(token));
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
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

    const a = await prisma.company.create({ data: { name: `ScA ${suffix}`, dataRegion: 'test' } });
    const b = await prisma.company.create({ data: { name: `ScB ${suffix}`, dataRegion: 'test' } });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local` },
      });
      userIds.push(user.id);
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'sc-rec-a');
    adminA = await makeUser(companyA, UserRole.ADMIN, 'sc-admin-a');
    hmAssigned = await makeUser(companyA, UserRole.HIRING_MANAGER, 'sc-hm-yes');
    hmUnassigned = await makeUser(companyA, UserRole.HIRING_MANAGER, 'sc-hm-no');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'sc-rec-b');
    candidateUser = await makeUser(companyA, UserRole.CANDIDATE, 'sc-cand');

    const recA: AuthenticatedUser = {
      id: recruiterA,
      email: `sc-rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recB: AuthenticatedUser = {
      id: recruiterB,
      email: `sc-rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    const created = await jobs.create(recA, { title: `Sc job ${suffix}` });
    await jobs.update(recA, created.id, { status: JobStatus.PUBLISHED });
    jobAssigned = created.id;
    await prisma.jobAssignment.create({ data: { jobId: jobAssigned, userId: hmAssigned } });

    const createdB = await jobs.create(recB, { title: `Sc jobB ${suffix}` });
    await jobs.update(recB, createdB.id, { status: JobStatus.PUBLISHED });
    jobB = createdB.id;
  });

  afterAll(async () => {
    const owner = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);

    try {
      await owner.$connect();

      const applicationIds = (
        await owner.application.findMany({
          where: { job: { companyId: { in: [companyA, companyB] } } },
          select: { id: true },
        })
      ).map((row) => row.id);

      await owner.scorecard.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.stageHistory.deleteMany({ where: { applicationId: { in: applicationIds } } });
      await owner.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await owner.auditLog.deleteMany({ where: { resourceId: { in: applicationIds } } });
      await owner.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
      await owner.candidate.deleteMany({ where: { email: { contains: suffix } } });
    } finally {
      await owner.$disconnect();
      await app.close();
    }
  });

  // =========================================================================
  // Submitting
  // =========================================================================
  describe('POST /applications/:id/scorecards', () => {
    it('a Recruiter submits a rating and feedback', async () => {
      const id = await newApplication('sub1');

      const response = await submit(
        id,
        { rating: 4, feedback: 'Strong on system design.' },
        await tokenFor(recruiterA),
      ).expect(201);

      expect(response.body).toMatchObject({
        rating: 4,
        feedback: 'Strong on system design.',
        author: { id: recruiterA, role: 'RECRUITER' },
      });
      expect(response.body.submittedAt).toBeTruthy();
    });

    it('persists it against the application', async () => {
      const id = await newApplication('sub2');
      await submit(id, { rating: 3 }, await tokenFor(recruiterA)).expect(201);

      const rows = await prisma.scorecard.findMany({ where: { applicationId: id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rating: 3, authorId: recruiterA });
    });

    it('accepts a rating with no feedback — feedback is nullable', async () => {
      const id = await newApplication('sub3');

      const response = await submit(id, { rating: 5 }, await tokenFor(recruiterA)).expect(201);
      expect(response.body.feedback).toBeNull();
    });

    it('stores blank feedback as null rather than an empty string', async () => {
      const id = await newApplication('sub4');

      const response = await submit(
        id,
        { rating: 2, feedback: '   ' },
        await tokenFor(recruiterA),
      ).expect(201);

      expect(response.body.feedback).toBeNull();
    });

    it('an assigned Hiring Manager may submit (§24.2)', async () => {
      const id = await newApplication('sub5');
      await submit(id, { rating: 4 }, await tokenFor(hmAssigned)).expect(201);
    });

    it('an Admin may submit', async () => {
      const id = await newApplication('sub6');
      await submit(id, { rating: 4 }, await tokenFor(adminA)).expect(201);
    });

    /**
     * Handoff §I's audit vocabulary contains no scorecard event, so none is
     * invented. Asserted so that adding one later is a deliberate act.
     */
    it('writes no audit record — no scorecard action exists in the vocabulary', async () => {
      const id = await newApplication('sub7');
      await submit(id, { rating: 4 }, await tokenFor(recruiterA)).expect(201);

      const rows = await prisma.auditLog.findMany({
        where: { resourceId: id, action: { not: 'application.submitted' } },
      });
      expect(rows).toHaveLength(0);
    });
  });

  // =========================================================================
  // One per author (approved)
  // =========================================================================
  describe('one scorecard per author per application', () => {
    it('a second submission by the same author returns 409', async () => {
      const id = await newApplication('dup1');
      const token = await tokenFor(recruiterA);

      await submit(id, { rating: 4 }, token).expect(201);
      const response = await submit(id, { rating: 2 }, token).expect(409);

      expect(response.body.detail).toMatch(/already submitted a scorecard/i);
    });

    it('the duplicate does not overwrite the original', async () => {
      const id = await newApplication('dup2');
      const token = await tokenFor(recruiterA);

      await submit(id, { rating: 5, feedback: 'First' }, token).expect(201);
      await submit(id, { rating: 1, feedback: 'Second' }, token).expect(409);

      const rows = await prisma.scorecard.findMany({ where: { applicationId: id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rating: 5, feedback: 'First' });
    });

    it('a DIFFERENT author may still submit on the same application', async () => {
      const id = await newApplication('dup3');

      await submit(id, { rating: 4 }, await tokenFor(recruiterA)).expect(201);
      await submit(id, { rating: 3 }, await tokenFor(hmAssigned)).expect(201);
      await submit(id, { rating: 5 }, await tokenFor(adminA)).expect(201);

      await expect(prisma.scorecard.count({ where: { applicationId: id } })).resolves.toBe(3);
    });

    it('the same author may score a DIFFERENT application', async () => {
      const first = await newApplication('dup4a');
      const second = await newApplication('dup4b');
      const token = await tokenFor(recruiterA);

      await submit(first, { rating: 4 }, token).expect(201);
      await submit(second, { rating: 4 }, token).expect(201);
    });

    /**
     * The constraint is in the database, not in a service lookup, precisely
     * so two simultaneous submissions cannot both pass a read-then-write.
     */
    it('concurrent duplicate submissions create exactly ONE row', async () => {
      const id = await newApplication('dup5');
      const token = await tokenFor(recruiterA);

      const results = await Promise.all([
        submit(id, { rating: 4 }, token),
        submit(id, { rating: 2 }, token),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      await expect(prisma.scorecard.count({ where: { applicationId: id } })).resolves.toBe(1);
    });
  });

  // =========================================================================
  // Rating validation
  // =========================================================================
  describe('rating validation', () => {
    it(`accepts the boundaries ${MIN_RATING} and ${MAX_RATING}`, async () => {
      const low = await newApplication('rate-low');
      const high = await newApplication('rate-high');
      const token = await tokenFor(recruiterA);

      await submit(low, { rating: MIN_RATING }, token).expect(201);
      await submit(high, { rating: MAX_RATING }, token).expect(201);
    });

    it('rejects 0 and 6', async () => {
      const id = await newApplication('rate-out');
      const token = await tokenFor(recruiterA);

      const zero = await submit(id, { rating: 0 }, token).expect(400);
      expect(zero.body.detail).toMatch(/between 1 and 5/i);
      await submit(id, { rating: 6 }, token).expect(400);
    });

    it('rejects a fractional rating', async () => {
      const id = await newApplication('rate-frac');
      await submit(id, { rating: 3.5 }, await tokenFor(recruiterA)).expect(400);
    });

    it('rejects a missing rating', async () => {
      const id = await newApplication('rate-none');
      await submit(id, { feedback: 'no rating' }, await tokenFor(recruiterA)).expect(400);
    });

    it('rejects a non-numeric rating', async () => {
      const id = await newApplication('rate-str');
      await submit(id, { rating: 'five' }, await tokenFor(recruiterA)).expect(400);
    });

    /** Deferred by decision — a silently discarded field is worse than none. */
    it('rejects deferred fields such as a draft flag or structured prompts', async () => {
      const id = await newApplication('rate-extra');
      const token = await tokenFor(recruiterA);

      await submit(id, { rating: 4, isDraft: true }, token).expect(400);
      await submit(id, { rating: 4, prompts: { culture: 3 } }, token).expect(400);
    });

    it('rejects a spoofed authorId — the author is the caller', async () => {
      const id = await newApplication('rate-spoof');
      await submit(id, { rating: 4, authorId: adminA }, await tokenFor(recruiterA)).expect(400);
    });
  });

  // =========================================================================
  // FR5.3 team visibility
  // =========================================================================
  describe('GET /applications/:id/scorecards', () => {
    it('shows the whole team every scorecard, not just their own', async () => {
      const id = await newApplication('read1');
      await submit(id, { rating: 4, feedback: 'From recruiter' }, await tokenFor(recruiterA));
      await submit(id, { rating: 3, feedback: 'From HM' }, await tokenFor(hmAssigned));

      const response = await list(id, await tokenFor(hmAssigned)).expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.data.map((s: { author: { id: string } }) => s.author.id).sort()).toEqual(
        [recruiterA, hmAssigned].sort(),
      );
    });

    it('names the author beside each entry (RC-13)', async () => {
      const id = await newApplication('read2');
      await submit(id, { rating: 4 }, await tokenFor(recruiterA));

      const response = await list(id, await tokenFor(adminA)).expect(200);

      expect(response.body.data[0].author).toMatchObject({
        id: recruiterA,
        email: `sc-rec-a.${suffix}@test.local`,
        role: 'RECRUITER',
      });
    });

    it('returns an empty list, not an error, when nobody has scored yet', async () => {
      const id = await newApplication('read3');

      const response = await list(id, await tokenFor(recruiterA)).expect(200);
      expect(response.body.data).toEqual([]);
    });

    it('orders oldest first', async () => {
      const id = await newApplication('read4');
      await submit(id, { rating: 1 }, await tokenFor(recruiterA));
      await submit(id, { rating: 2 }, await tokenFor(hmAssigned));
      await submit(id, { rating: 3 }, await tokenFor(adminA));

      const response = await list(id, await tokenFor(recruiterA)).expect(200);
      expect(response.body.data.map((s: { rating: number }) => s.rating)).toEqual([1, 2, 3]);
    });
  });

  // =========================================================================
  // Authorisation
  // =========================================================================
  describe('authorisation', () => {
    it('requires authentication on both routes', async () => {
      const id = await newApplication('authz1');

      await request(app.getHttpServer())
        .post(`/applications/${id}/scorecards`)
        .send({ rating: 4 })
        .expect(401);
      await request(app.getHttpServer()).get(`/applications/${id}/scorecards`).expect(401);
    });

    /**
     * A scorecard is the team's assessment OF the candidate. BR-06 governs a
     * candidate's access to their OWN data; this is not that, and it must
     * never flow back to the person being assessed.
     */
    it('a CANDIDATE can neither submit nor read', async () => {
      const id = await newApplication('authz2');
      await submit(id, { rating: 5 }, await tokenFor(recruiterA)).expect(201);

      const token = await tokenFor(candidateUser);
      await submit(id, { rating: 5 }, token).expect(403);
      await list(id, token).expect(403);
    });

    it('§24.2: an UNASSIGNED Hiring Manager gets 404, not 403', async () => {
      const id = await newApplication('authz3');

      const token = await tokenFor(hmUnassigned);
      const posted = await submit(id, { rating: 4 }, token).expect(404);
      await list(id, token).expect(404);

      expect(posted.body.status).toBe(404);
      await expect(prisma.scorecard.count({ where: { applicationId: id } })).resolves.toBe(0);
    });

    it('an unassigned job is indistinguishable from a missing application', async () => {
      const id = await newApplication('authz4');
      const token = await tokenFor(hmUnassigned);

      const unassigned = await list(id, token).expect(404);
      const missing = await list(randomUUID(), token).expect(404);

      expect(unassigned.body.detail).toBe(missing.body.detail);
      expect(unassigned.body.title).toBe(missing.body.title);
    });

    it('BR-06: a Recruiter from another tenant gets 404 on both routes', async () => {
      const id = await newApplication('authz5');
      const token = await tokenFor(recruiterB);

      await submit(id, { rating: 4 }, token).expect(404);
      await list(id, token).expect(404);
      await expect(prisma.scorecard.count({ where: { applicationId: id } })).resolves.toBe(0);
    });

    it('cannot reach an application in another tenant from the other direction', async () => {
      const idInB = await newApplication('authz6', jobB);
      await submit(idInB, { rating: 4 }, await tokenFor(recruiterA)).expect(404);
    });

    it('rejects a malformed application id', async () => {
      await request(app.getHttpServer())
        .post('/applications/not-a-uuid/scorecards')
        .set(auth(await tokenFor(recruiterA)))
        .send({ rating: 4 })
        .expect(400);
    });
  });
});
