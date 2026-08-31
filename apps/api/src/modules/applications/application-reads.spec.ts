import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JobStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ApplicationsModule } from './applications.module';
import { TagsModule } from '../tags/tags.module';
import { ApplicationsService } from './applications.service';
import { CommonModule } from '../../common/common.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { CandidateOwnershipGuard } from '../../common/guards/candidate-ownership.guard';
import { JobAssignmentGuard } from '../../common/guards/job-assignment.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
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
 * GET /v1/applications/:id and GET /v1/jobs/:id/candidates
 * (Handoff §B rows 13–14, Phase 1 CA-05 and RC-05).
 *
 * This harness registers the REAL guard chain in main.ts's order, and issues
 * REAL access tokens. Almost everything these two routes do is access
 * control — tenant isolation, candidate ownership, the Hiring Manager's
 * assigned-jobs restriction — and a harness without guards would assert none
 * of it while appearing to pass.
 */
describe('Application reads (BR-06 access control)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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
  let candidateOwner = '';
  let candidateOther = '';

  let jobAssigned = '';
  let jobUnassigned = '';
  let jobB = '';

  let ownedApplicationId = '';
  let otherApplicationId = '';
  let applicationInB = '';

  const pdf = () =>
    ({
      fieldname: 'resume',
      originalname: 'resume.pdf',
      encoding: '7bit',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
      size: 16,
    }) as Express.Multer.File;

  /** A real signed access token for a real user row. */
  async function tokenFor(userId: string): Promise<string> {
    const user = await prisma.users.findUniqueOrThrow({ where: { id: userId } });
    return tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    });
  }

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
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
        // FR5.2 — tag routes hang off /applications and are exercised below.
        TagsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: RequestContext, res: Response, next: NextFunction) =>
      new CorrelationIdMiddleware().use(req, res, next),
    );

    // Mirrors main.ts exactly — the order is a security property.
    const reflector = app.get(Reflector);
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

    // ---- two tenants -----------------------------------------------------
    const a = await prisma.company.create({
      data: { name: `ReadA ${suffix}`, dataRegion: 'test' },
    });
    const b = await prisma.company.create({
      data: { name: `ReadB ${suffix}`, dataRegion: 'test' },
    });
    companyA = a.id;
    companyB = b.id;

    async function makeUser(companyId: string, role: UserRole, tag: string): Promise<string> {
      const user = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local` },
      });
      return user.id;
    }

    recruiterA = await makeUser(companyA, UserRole.RECRUITER, 'rec-a');
    adminA = await makeUser(companyA, UserRole.ADMIN, 'admin-a');
    hmAssigned = await makeUser(companyA, UserRole.HIRING_MANAGER, 'hm-yes');
    hmUnassigned = await makeUser(companyA, UserRole.HIRING_MANAGER, 'hm-no');
    recruiterB = await makeUser(companyB, UserRole.RECRUITER, 'rec-b');
    candidateOwner = await makeUser(companyA, UserRole.CANDIDATE, 'cand-own');
    candidateOther = await makeUser(companyA, UserRole.CANDIDATE, 'cand-other');

    const recruiterAUser: AuthenticatedUser = {
      id: recruiterA,
      email: `rec-a.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyA,
    };
    const recruiterBUser: AuthenticatedUser = {
      id: recruiterB,
      email: `rec-b.${suffix}@test.local`,
      role: UserRole.RECRUITER,
      companyId: companyB,
    };

    // ---- jobs ------------------------------------------------------------
    const assigned = await jobs.create(recruiterAUser, { title: `Assigned ${suffix}` });
    await jobs.update(recruiterAUser, assigned.id, { status: JobStatus.PUBLISHED });
    jobAssigned = assigned.id;
    await prisma.jobAssignment.create({ data: { jobId: jobAssigned, userId: hmAssigned } });

    const unassigned = await jobs.create(recruiterAUser, { title: `Unassigned ${suffix}` });
    await jobs.update(recruiterAUser, unassigned.id, { status: JobStatus.PUBLISHED });
    jobUnassigned = unassigned.id;

    const inB = await jobs.create(recruiterBUser, { title: `TenantB ${suffix}` });
    await jobs.update(recruiterBUser, inB.id, { status: JobStatus.PUBLISHED });
    jobB = inB.id;

    // ---- applications ----------------------------------------------------
    const owned = await applications.submit(
      { jobId: jobAssigned, fullName: 'Owner Candidate', email: `owner.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
    ownedApplicationId = owned.application.id;
    // Link the profile to the candidate login (approved M2.5 identity model).
    await prisma.candidate.update({
      where: { id: owned.candidate.id },
      data: { userId: candidateOwner },
    });

    const other = await applications.submit(
      { jobId: jobAssigned, fullName: 'Other Candidate', email: `other.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
    otherApplicationId = other.application.id;
    await prisma.candidate.update({
      where: { id: other.candidate.id },
      data: { userId: candidateOther },
    });

    const inTenantB = await applications.submit(
      { jobId: jobB, fullName: 'Tenant B Candidate', email: `tb.${suffix}@test.local` },
      pdf(),
      CORRELATION,
    );
    applicationInB = inTenantB.application.id;
  });

  afterAll(async () => {
    await prisma.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
    await prisma.candidate.deleteMany({ where: { email: { contains: suffix } } });
    await app.close();
  });

  // =========================================================================
  // GET /applications/:id
  // =========================================================================
  describe('GET /applications/:id (CA-05)', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).get(`/applications/${ownedApplicationId}`).expect(401);
    });

    it('lets the owning candidate read their own application', async () => {
      const response = await request(app.getHttpServer())
        .get(`/applications/${ownedApplicationId}`)
        .set(auth(await tokenFor(candidateOwner)))
        .expect(200);

      expect(response.body).toMatchObject({
        id: ownedApplicationId,
        currentStage: 'Applied',
        candidate: { fullName: 'Owner Candidate' },
      });
      expect(response.body.job.title).toBe(`Assigned ${suffix}`);
    });

    /**
     * FR5.2 — application tags.
     *
     * The access decision is that CANDIDATE is absent from the controller
     * entirely, so these assert refusal at the route rather than a filtered
     * response, plus the tenant and duplicate rules.
     */
    describe('tags (FR5.2)', () => {
      afterEach(async () => {
        await prisma.applicationTag.deleteMany({
          where: { applicationId: { in: [ownedApplicationId, applicationInB] } },
        });
        /*
         * The audit rows these tests emit must go too: `audit_logs.company_id`
         * is ON DELETE RESTRICT (amendment A4), so leaving them blocks the
         * suite's own `company.deleteMany` teardown. Same cleanup the pipeline
         * specs already do for their transitions.
         */
        await prisma.auditLog.deleteMany({
          where: { action: { in: ['application.tagged', 'application.untagged'] } },
        });
      });

      it('lets a recruiter add, list and remove a tag', async () => {
        const created = await request(app.getHttpServer())
          .post(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(recruiterA)))
          .send({ label: 'Strong communicator' })
          .expect(201);

        expect(created.body.label).toBe('Strong communicator');
        expect(created.body.createdByEmail).toContain('@');
        // No internal identifiers alongside the actor.
        expect(created.body).not.toHaveProperty('createdBy');

        const listed = await request(app.getHttpServer())
          .get(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(recruiterA)))
          .expect(200);
        expect(listed.body.data).toHaveLength(1);

        await request(app.getHttpServer())
          .delete(`/applications/${ownedApplicationId}/tags/${created.body.id}`)
          .set(auth(await tokenFor(recruiterA)))
          .expect(204);

        const after = await request(app.getHttpServer())
          .get(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(recruiterA)))
          .expect(200);
        expect(after.body.data).toHaveLength(0);
      });

      it('refuses a CANDIDATE outright — tags are staff-only', async () => {
        await request(app.getHttpServer())
          .get(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(candidateOwner)))
          .expect(403);

        await request(app.getHttpServer())
          .post(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(candidateOwner)))
          .send({ label: 'self-added' })
          .expect(403);
      });

      it('rejects a duplicate case-insensitively, in the database', async () => {
        await request(app.getHttpServer())
          .post(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(recruiterA)))
          .send({ label: 'Python' })
          .expect(201);

        await request(app.getHttpServer())
          .post(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(recruiterA)))
          .send({ label: 'python' })
          .expect(409);
      });

      it('rejects an empty or over-long label', async () => {
        await request(app.getHttpServer())
          .post(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(recruiterA)))
          .send({ label: '   ' })
          .expect(400);

        await request(app.getHttpServer())
          .post(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(recruiterA)))
          .send({ label: 'x'.repeat(41) })
          .expect(400);
      });

      it('404s a recruiter from another tenant (BR-06, never 403)', async () => {
        await request(app.getHttpServer())
          .get(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(recruiterB)))
          .expect(404);

        await request(app.getHttpServer())
          .post(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(recruiterB)))
          .send({ label: 'cross-tenant' })
          .expect(404);
      });

      it('404s a Hiring Manager on a job they are not assigned to', async () => {
        await request(app.getHttpServer())
          .get(`/applications/${ownedApplicationId}/tags`)
          .set(auth(await tokenFor(hmUnassigned)))
          .expect(404);
      });

      describe('bulk (FR5.2)', () => {
        it('tags every accessible application and reports the rest', async () => {
          const res = await request(app.getHttpServer())
            .post('/applications/bulk/tags')
            .set(auth(await tokenFor(recruiterA)))
            // One real, one from another tenant, one that does not exist.
            .send({
              applicationIds: [
                ownedApplicationId,
                applicationInB,
                '00000000-0000-4000-8000-0000000000ff',
              ],
              label: 'Shortlist',
            })
            .expect(200);

          expect(res.body.tagged).toEqual([ownedApplicationId]);
          expect(res.body.alreadyTagged).toEqual([]);
          // NOT silently dropped — each is named with a reason.
          expect(res.body.failed).toHaveLength(2);
          expect(res.body.failed.map((f: { id: string }) => f.id).sort()).toEqual(
            [applicationInB, '00000000-0000-4000-8000-0000000000ff'].sort(),
          );
          // BR-06 — the same wording for missing and cross-tenant.
          expect(new Set(res.body.failed.map((f: { reason: string }) => f.reason)).size).toBe(1);

          // The cross-tenant application was genuinely not written to.
          const leaked = await prisma.applicationTag.count({
            where: { applicationId: applicationInB },
          });
          expect(leaked).toBe(0);
        });

        it('reports an already-tagged application separately from a new one', async () => {
          await request(app.getHttpServer())
            .post('/applications/bulk/tags')
            .set(auth(await tokenFor(recruiterA)))
            .send({ applicationIds: [ownedApplicationId], label: 'Shortlist' })
            .expect(200);

          const second = await request(app.getHttpServer())
            .post('/applications/bulk/tags')
            .set(auth(await tokenFor(recruiterA)))
            // Different case — the database index is case-insensitive.
            .send({ applicationIds: [ownedApplicationId], label: 'SHORTLIST' })
            .expect(200);

          expect(second.body.tagged).toEqual([]);
          expect(second.body.alreadyTagged).toEqual([ownedApplicationId]);
          // Exactly one row, so no duplicate slipped past the index.
          expect(
            await prisma.applicationTag.count({ where: { applicationId: ownedApplicationId } }),
          ).toBe(1);
        });

        it('writes NO audit row when nothing was actually tagged', async () => {
          await request(app.getHttpServer())
            .post('/applications/bulk/tags')
            .set(auth(await tokenFor(recruiterA)))
            .send({ applicationIds: [ownedApplicationId], label: 'Shortlist' })
            .expect(200);

          const afterFirst = await prisma.auditLog.count({
            where: { action: 'application.tagged' },
          });

          await request(app.getHttpServer())
            .post('/applications/bulk/tags')
            .set(auth(await tokenFor(recruiterA)))
            .send({ applicationIds: [ownedApplicationId], label: 'Shortlist' })
            .expect(200);

          // A no-op must not claim a write happened.
          expect(await prisma.auditLog.count({ where: { action: 'application.tagged' } })).toBe(
            afterFirst,
          );
        });

        it('refuses a CANDIDATE and an unauthenticated caller', async () => {
          await request(app.getHttpServer())
            .post('/applications/bulk/tags')
            .set(auth(await tokenFor(candidateOwner)))
            .send({ applicationIds: [ownedApplicationId], label: 'nope' })
            .expect(403);

          await request(app.getHttpServer())
            .post('/applications/bulk/tags')
            .send({ applicationIds: [ownedApplicationId], label: 'nope' })
            .expect(401);
        });

        it('tags nothing for a Hiring Manager on an unassigned job', async () => {
          const res = await request(app.getHttpServer())
            .post('/applications/bulk/tags')
            .set(auth(await tokenFor(hmUnassigned)))
            .send({ applicationIds: [ownedApplicationId], label: 'hm-attempt' })
            .expect(200);

          expect(res.body.tagged).toEqual([]);
          expect(res.body.failed).toHaveLength(1);
        });

        it('rejects an empty label, an empty selection and a bad id', async () => {
          const bad = [
            { applicationIds: [ownedApplicationId], label: '  ' },
            { applicationIds: [], label: 'x' },
            { applicationIds: ['not-a-uuid'], label: 'x' },
            { applicationIds: [ownedApplicationId], label: 'x'.repeat(41) },
          ];
          for (const body of bad) {
            await request(app.getHttpServer())
              .post('/applications/bulk/tags')
              .set(auth(await tokenFor(recruiterA)))
              .send(body)
              .expect(400);
          }
        });
      });

      it('rejects a malformed application id as 400', async () => {
        await request(app.getHttpServer())
          .get('/applications/not-a-uuid/tags')
          .set(auth(await tokenFor(recruiterA)))
          .expect(400);
      });
    });

    /**
     * FR5.4 — "every stage transition is recorded with actor and timestamp".
     * Exposed to the hiring team, withheld from the subject like `score`.
     */
    it('returns stage history to staff, chronologically, and withholds it from the candidate', async () => {
      await prisma.stageHistory.createMany({
        data: [
          {
            applicationId: ownedApplicationId,
            fromStage: 'Applied',
            toStage: 'Screening',
            changedBy: recruiterA,
            changedAt: new Date('2026-08-01T10:00:00.000Z'),
          },
          {
            applicationId: ownedApplicationId,
            fromStage: 'Screening',
            toStage: 'Interview',
            changedBy: recruiterA,
            changedAt: new Date('2026-08-05T09:00:00.000Z'),
          },
        ],
      });

      try {
        const asRecruiter = await request(app.getHttpServer())
          .get(`/applications/${ownedApplicationId}`)
          .set(auth(await tokenFor(recruiterA)))
          .expect(200);

        const history = asRecruiter.body.stageHistory;
        expect(history).toHaveLength(2);
        // Oldest first — a timeline, not a feed.
        expect(history[0].toStage).toBe('Screening');
        expect(history[1].toStage).toBe('Interview');
        expect(history[0].fromStage).toBe('Applied');
        expect(history[0].actorEmail).toContain('@');
        // No internal identifiers leak alongside the actor.
        expect(history[0]).not.toHaveProperty('changedBy');
        expect(history[0]).not.toHaveProperty('id');
        expect(history[0]).not.toHaveProperty('applicationId');

        const asCandidate = await request(app.getHttpServer())
          .get(`/applications/${ownedApplicationId}`)
          .set(auth(await tokenFor(candidateOwner)))
          .expect(200);

        // Null, not [] — the candidate is told nothing, not "no history".
        expect(asCandidate.body.stageHistory).toBeNull();
      } finally {
        await prisma.stageHistory.deleteMany({ where: { applicationId: ownedApplicationId } });
      }
    });

    /**
     * FR3.2 / §24.2 Table 24.1 — a Candidate reviews their own extracted
     * details (FR2.2) but never sees HOW they were produced, exactly as they
     * never see `score` or `source`. Rule confidences and the parser's identity
     * describe our internals, not their application.
     */
    it('withholds parser internals from the candidate but not from the recruiter', async () => {
      const resume = await prisma.resume.findFirst({
        where: { applicationId: ownedApplicationId },
      });
      await prisma.parsedProfile.create({
        data: {
          resumeId: resume!.id,
          contact: {
            name: 'Owner Candidate',
            email: 'owner@example.com',
            phone: null,
            location: null,
          },
          skills: ['TypeScript'],
          fieldConfidence: { 'contact.email': 0.95 },
          confidenceScore: 0.84,
          parserName: 'rule-based-local',
          parserVersion: 'v1',
        },
      });

      try {
        const asCandidate = await request(app.getHttpServer())
          .get(`/applications/${ownedApplicationId}`)
          .set(auth(await tokenFor(candidateOwner)))
          .expect(200);

        const candidateProfile = asCandidate.body.resume.parsedProfile;
        // FR2.2 — their own details stay visible so they can be corrected.
        expect(candidateProfile.contact).toMatchObject({ name: 'Owner Candidate' });
        expect(candidateProfile.skills).toEqual(['TypeScript']);
        // Internals withheld, following `score` and `source`.
        expect(candidateProfile.fieldConfidence).toBeNull();
        expect(candidateProfile.confidenceScore).toBeNull();
        expect(candidateProfile.parserName).toBeNull();
        expect(candidateProfile.parserVersion).toBeNull();

        const asRecruiter = await request(app.getHttpServer())
          .get(`/applications/${ownedApplicationId}`)
          .set(auth(await tokenFor(recruiterA)))
          .expect(200);

        const recruiterProfile = asRecruiter.body.resume.parsedProfile;
        expect(recruiterProfile.fieldConfidence).toEqual({ 'contact.email': 0.95 });
        expect(recruiterProfile.confidenceScore).toBe(0.84);
        expect(recruiterProfile.parserName).toBe('rule-based-local');
        expect(recruiterProfile.parserVersion).toBe('v1');
      } finally {
        // Left as the other tests found it — they assert on this application.
        await prisma.parsedProfile.deleteMany({ where: { resumeId: resume!.id } });
      }
    });

    /**
     * BR-06 / PRD §26 — the headline rule: "a candidate token requesting
     * another candidate's application must receive 404, not 403, to avoid
     * existence disclosure".
     */
    it('BR-06: another candidate gets 404, NOT 403', async () => {
      const response = await request(app.getHttpServer())
        .get(`/applications/${ownedApplicationId}`)
        .set(auth(await tokenFor(candidateOther)))
        .expect(404);

      expect(response.body.status).toBe(404);
    });

    it("a foreign application is indistinguishable from one that doesn't exist", async () => {
      const token = await tokenFor(candidateOther);

      const foreign = await request(app.getHttpServer())
        .get(`/applications/${ownedApplicationId}`)
        .set(auth(token))
        .expect(404);
      const missing = await request(app.getHttpServer())
        .get(`/applications/${randomUUID()}`)
        .set(auth(token))
        .expect(404);

      expect(foreign.body.detail).toBe(missing.body.detail);
      expect(foreign.body.title).toBe(missing.body.title);
    });

    it('lets a Recruiter in the owning tenant read it', async () => {
      await request(app.getHttpServer())
        .get(`/applications/${ownedApplicationId}`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);
    });

    it('lets an Admin in the owning tenant read it', async () => {
      await request(app.getHttpServer())
        .get(`/applications/${ownedApplicationId}`)
        .set(auth(await tokenFor(adminA)))
        .expect(200);
    });

    /** R-09 — tenancy is reached through the job, since applications carry no company_id. */
    it('404s a Recruiter from another tenant', async () => {
      await request(app.getHttpServer())
        .get(`/applications/${ownedApplicationId}`)
        .set(auth(await tokenFor(recruiterB)))
        .expect(404);
    });

    it('404s a Recruiter reading into the other direction too', async () => {
      await request(app.getHttpServer())
        .get(`/applications/${applicationInB}`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(404);
    });

    /**
     * Handoff row 13 lists Candidate, Recruiter and Admin — not HM. An HM
     * reaches candidate data only through a job they are assigned to.
     */
    it('refuses a Hiring Manager — not on row 13', async () => {
      await request(app.getHttpServer())
        .get(`/applications/${ownedApplicationId}`)
        .set(auth(await tokenFor(hmAssigned)))
        .expect(403);
    });

    it('never exposes the resume storage key', async () => {
      const response = await request(app.getHttpServer())
        .get(`/applications/${ownedApplicationId}`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('resumes/');
      expect(response.body.resume).not.toHaveProperty('s3Key');
      expect(response.body.resume.parseStatus).toBe('PENDING');
    });

    it('rejects a malformed id as 400', async () => {
      await request(app.getHttpServer())
        .get('/applications/not-a-uuid')
        .set(auth(await tokenFor(recruiterA)))
        .expect(400);
    });
  });

  // =========================================================================
  // GET /jobs/:id/candidates
  // =========================================================================
  describe('GET /jobs/:id/candidates (RC-05)', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).get(`/jobs/${jobAssigned}/candidates`).expect(401);
    });

    it('lists the applicants for a Recruiter in the tenant', async () => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates?limit=100`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const ids = response.body.data.map((row: { applicationId: string }) => row.applicationId);
      expect(ids).toContain(ownedApplicationId);
      expect(ids).toContain(otherApplicationId);
    });

    /**
     * FR4.5 — "candidates are presented in reverse-chronological order with
     * no score displayed". No AI runs in Phase 2, so this is the specified
     * Phase 2 rendering rather than a placeholder.
     */
    it('FR4.5: newest first, with score present and null', async () => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates?limit=100`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      const rows = response.body.data as { appliedAt: string; score: null }[];
      const times = rows.map((r) => new Date(r.appliedAt).getTime());
      expect([...times].sort((x, y) => y - x)).toEqual(times);

      for (const row of rows) {
        expect(row).toHaveProperty('score');
        expect(row.score).toBeNull();
      }
    });

    it('the newest applicant is first', async () => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates?limit=100`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(response.body.data[0].applicationId).toBe(otherApplicationId);
    });

    it('lets a Hiring Manager read a job they are ASSIGNED to', async () => {
      await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates`)
        .set(auth(await tokenFor(hmAssigned)))
        .expect(200);
    });

    /** PRD §24.2 — HM sees assigned jobs only (decision B1). */
    it('404s a Hiring Manager on a job they are NOT assigned to', async () => {
      await request(app.getHttpServer())
        .get(`/jobs/${jobUnassigned}/candidates`)
        .set(auth(await tokenFor(hmUnassigned)))
        .expect(404);
    });

    it('404s a Recruiter from another tenant', async () => {
      await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates`)
        .set(auth(await tokenFor(recruiterB)))
        .expect(404);
    });

    it('an unassigned job is indistinguishable from a missing one', async () => {
      const token = await tokenFor(hmUnassigned);

      const unassigned = await request(app.getHttpServer())
        .get(`/jobs/${jobUnassigned}/candidates`)
        .set(auth(token))
        .expect(404);
      const missing = await request(app.getHttpServer())
        .get(`/jobs/${randomUUID()}/candidates`)
        .set(auth(token))
        .expect(404);

      expect(unassigned.body.detail).toBe(missing.body.detail);
    });

    it('refuses a Candidate outright — candidate lists are staff-only', async () => {
      await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates`)
        .set(auth(await tokenFor(candidateOwner)))
        .expect(403);
    });

    it('returns an empty list, not an error, for a job with no applicants', async () => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${jobUnassigned}/candidates`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.nextCursor).toBeNull();
    });

    // ---- pagination ------------------------------------------------------

    it('honours limit and pages without repeating a row', async () => {
      const token = await tokenFor(recruiterA);

      const first = await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates?limit=1`)
        .set(auth(token))
        .expect(200);
      expect(first.body.data).toHaveLength(1);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates?limit=1&cursor=${first.body.nextCursor}`)
        .set(auth(token))
        .expect(200);

      expect(second.body.data[0].applicationId).not.toBe(first.body.data[0].applicationId);
    });

    it('rejects a limit outside 1–100', async () => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates?limit=0`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(400);

      expect(response.body.detail).toMatch(/between 1 and 100/i);
    });

    it('refuses an unrecognised filter rather than ignoring it', async () => {
      await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}/candidates?stage=Applied`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(400);
    });

    it('does not collide with GET /jobs/:id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/jobs/${jobAssigned}`)
        .set(auth(await tokenFor(recruiterA)))
        .expect(200);

      expect(response.body.id).toBe(jobAssigned);
      expect(response.body).not.toHaveProperty('data');
    });
  });
});
