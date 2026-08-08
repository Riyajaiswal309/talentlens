import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobStatus, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { JobsService, toAuditSnapshot } from './jobs.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';

/**
 * JobsModule integration tests — require the M2.2 database.
 *
 * Run against real rows because the behaviour under test is relational:
 * tenant scoping, the Hiring Manager restriction through job_assignments, and
 * the pipeline stages created alongside each job (decision B2).
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

describe('JobsService (FR1.1–FR1.4)', () => {
  let prisma: PrismaService;
  let service: JobsService;

  const suffix = randomUUID().slice(0, 8);
  let companyA = '';
  let companyB = '';
  let recruiterA: AuthenticatedUser;
  let adminA: AuthenticatedUser;
  let hmAssigned: AuthenticatedUser;
  let hmUnassigned: AuthenticatedUser;
  let recruiterB: AuthenticatedUser;

  beforeAll(async () => {
    prisma = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await prisma.$connect();
    service = new JobsService(prisma);

    const a = await prisma.company.create({
      data: { name: `Jobs A ${suffix}`, dataRegion: 'test' },
    });
    const b = await prisma.company.create({
      data: { name: `Jobs B ${suffix}`, dataRegion: 'test' },
    });
    companyA = a.id;
    companyB = b.id;

    const mk = async (
      companyId: string,
      role: UserRole,
      tag: string,
    ): Promise<AuthenticatedUser> => {
      const u = await prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local` },
      });
      return { id: u.id, email: u.email, role: u.role, companyId: u.companyId };
    };

    recruiterA = await mk(companyA, UserRole.RECRUITER, 'jr-rec-a');
    adminA = await mk(companyA, UserRole.ADMIN, 'jr-adm-a');
    hmAssigned = await mk(companyA, UserRole.HIRING_MANAGER, 'jr-hm-yes');
    hmUnassigned = await mk(companyA, UserRole.HIRING_MANAGER, 'jr-hm-no');
    recruiterB = await mk(companyB, UserRole.RECRUITER, 'jr-rec-b');
  });

  afterAll(async () => {
    await prisma.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
    await prisma.$disconnect();
  });

  // =========================================================================
  // FR1.1 create + FR1.2 structured fields
  // =========================================================================
  describe('FR1.1/FR1.2 — create', () => {
    it('creates a job with every structured field from FR1.2', async () => {
      const job = await service.create(recruiterA, {
        title: 'Senior Backend Engineer',
        department: 'Engineering',
        location: 'Remote',
        employmentType: 'Full-time',
        experienceLevel: 'Senior',
        description: 'Build things.',
        requiredSkills: ['Python', 'SQL'],
      });

      expect(job.title).toBe('Senior Backend Engineer');
      expect(job.department).toBe('Engineering');
      expect(job.location).toBe('Remote');
      expect(job.employmentType).toBe('Full-time');
      expect(job.experienceLevel).toBe('Senior');
      expect(job.description).toBe('Build things.');
      expect(job.requiredSkills).toEqual(['Python', 'SQL']);
    });

    it('starts as DRAFT and unpublished', async () => {
      const job = await service.create(recruiterA, { title: `Draft ${suffix}` });
      expect(job.status).toBe(JobStatus.DRAFT);
      expect(job.publishedAt).toBeNull();
    });

    it('FR1.4/BR-04: aiScoringEnabled defaults to FALSE, so FR4.5 applies', async () => {
      const job = await service.create(recruiterA, { title: `AI off ${suffix}` });
      expect(job.aiScoringEnabled).toBe(false);
    });

    it('scopes the job to the creator tenant', async () => {
      const job = await service.create(recruiterA, { title: `Tenant ${suffix}` });
      expect(job.companyId).toBe(companyA);
    });

    it('decision B2: seeds the six PRD §14.1 stages in order', async () => {
      const job = await service.create(recruiterA, { title: `Stages ${suffix}` });
      const stages = await prisma.pipelineStage.findMany({
        where: { jobId: job.id },
        orderBy: { position: 'asc' },
      });

      expect(stages.map((s) => s.name)).toEqual([
        'Applied',
        'Screening',
        'Interview',
        'Offer',
        'Hired',
        'Rejected',
      ]);
      expect(stages.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('marks Hired and Rejected terminal (BR-01 confirmation points)', async () => {
      const job = await service.create(recruiterA, { title: `Terminal ${suffix}` });
      const stages = await prisma.pipelineStage.findMany({ where: { jobId: job.id } });

      const terminal = stages
        .filter((s) => s.isTerminal)
        .map((s) => s.name)
        .sort();
      expect(terminal).toEqual(['Hired', 'Rejected']);
    });
  });

  // =========================================================================
  // FR1.1 edit / publish / close
  // =========================================================================
  describe('FR1.1 — edit, publish, close', () => {
    it('edits structured fields', async () => {
      const job = await service.create(recruiterA, { title: `Edit ${suffix}` });
      const { after } = await service.update(recruiterA, job.id, {
        title: 'Edited title',
        department: 'Platform',
      });

      expect(after.title).toBe('Edited title');
      expect(after.department).toBe('Platform');
    });

    it('publishes and stamps publishedAt (PRD §7 North Star origin)', async () => {
      const job = await service.create(recruiterA, { title: `Publish ${suffix}` });
      const { after } = await service.update(recruiterA, job.id, {
        status: JobStatus.PUBLISHED,
      });

      expect(after.status).toBe(JobStatus.PUBLISHED);
      expect(after.publishedAt).toBeInstanceOf(Date);
    });

    it('does not overwrite publishedAt on a later edit', async () => {
      const job = await service.create(recruiterA, { title: `Stamp ${suffix}` });
      const published = await service.update(recruiterA, job.id, {
        status: JobStatus.PUBLISHED,
      });
      const first = published.after.publishedAt?.toISOString();

      const edited = await service.update(recruiterA, job.id, { title: 'Renamed' });
      expect(edited.after.publishedAt?.toISOString()).toBe(first);
    });

    it('closes and stamps closedAt', async () => {
      const job = await service.create(recruiterA, { title: `Close ${suffix}` });
      const { after } = await service.update(recruiterA, job.id, { status: JobStatus.CLOSED });

      expect(after.status).toBe(JobStatus.CLOSED);
      expect(after.closedAt).toBeInstanceOf(Date);
    });

    it('refuses to modify a CLOSED job (Phase 1 RC-04 read-only state)', async () => {
      const job = await service.create(recruiterA, { title: `Frozen ${suffix}` });
      await service.update(recruiterA, job.id, { status: JobStatus.CLOSED });

      await expect(service.update(recruiterA, job.id, { title: 'nope' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('refuses PUBLISHED -> DRAFT (unpublishing is not in the PRD)', async () => {
      const job = await service.create(recruiterA, { title: `Unpublish ${suffix}` });
      await service.update(recruiterA, job.id, { status: JobStatus.PUBLISHED });

      await expect(service.update(recruiterA, job.id, { status: JobStatus.DRAFT })).rejects.toThrow(
        ConflictException,
      );
    });

    it('returns before and after snapshots for the audit trail', async () => {
      const job = await service.create(recruiterA, { title: `Audit ${suffix}` });
      const { before, after } = await service.update(recruiterA, job.id, { title: 'Changed' });

      expect(toAuditSnapshot(before)).toMatchObject({ title: `Audit ${suffix}` });
      expect(toAuditSnapshot(after)).toMatchObject({ title: 'Changed' });
    });
  });

  // =========================================================================
  // FR1.3 duplicate
  // =========================================================================
  describe('FR1.3 — duplicate as template', () => {
    it('copies the structured fields', async () => {
      const source = await service.create(recruiterA, {
        title: `Template ${suffix}`,
        department: 'Engineering',
        requiredSkills: ['Go', 'Kubernetes'],
      });

      const copy = await service.duplicate(recruiterA, source.id);

      expect(copy.id).not.toBe(source.id);
      expect(copy.title).toBe(`Template ${suffix}`);
      expect(copy.department).toBe('Engineering');
      expect(copy.requiredSkills).toEqual(['Go', 'Kubernetes']);
    });

    it('always produces a DRAFT, even from a published source', async () => {
      const source = await service.create(recruiterA, { title: `Live ${suffix}` });
      await service.update(recruiterA, source.id, { status: JobStatus.PUBLISHED });

      const copy = await service.duplicate(recruiterA, source.id);

      expect(copy.status).toBe(JobStatus.DRAFT);
      expect(copy.publishedAt).toBeNull();
    });

    /**
     * BR-04 escalation guard. If duplication copied aiScoringEnabled, a
     * Recruiter could obtain an AI-enabled job by duplicating one an
     * Administrator had enabled — acquiring a permission §24.2 denies them
     * without ever calling the admin endpoint.
     */
    it('BR-04: never inherits aiScoringEnabled from the source', async () => {
      const source = await service.create(recruiterA, { title: `AI on ${suffix}` });
      await prisma.job.update({
        where: { id: source.id },
        data: { aiScoringEnabled: true }, // as an Administrator would
      });

      const copy = await service.duplicate(recruiterA, source.id);

      expect(copy.aiScoringEnabled).toBe(false);
    });

    it('copies the pipeline stage configuration (decision B2)', async () => {
      const source = await service.create(recruiterA, { title: `Custom ${suffix}` });
      // A per-job stage, exactly what B2 permits.
      await prisma.pipelineStage.create({
        data: { jobId: source.id, name: 'Shortlisted', position: 7, isTerminal: false },
      });

      const copy = await service.duplicate(recruiterA, source.id);
      const stages = await prisma.pipelineStage.findMany({
        where: { jobId: copy.id },
        orderBy: { position: 'asc' },
      });

      expect(stages.map((s) => s.name)).toContain('Shortlisted');
      expect(stages).toHaveLength(7);
    });

    it('cannot duplicate a job from another tenant', async () => {
      const foreign = await service.create(recruiterB, { title: `Foreign ${suffix}` });
      await expect(service.duplicate(recruiterA, foreign.id)).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // RBAC and tenant behaviour
  // =========================================================================
  describe('Tenant isolation and role visibility (PRD §24.2, BR-06)', () => {
    it('findOne refuses a job from another tenant — 404', async () => {
      const foreign = await service.create(recruiterB, { title: `Other ${suffix}` });
      await expect(service.findOne(recruiterA, foreign.id)).rejects.toThrow(NotFoundException);
    });

    it('list never returns another tenant jobs', async () => {
      await service.create(recruiterB, { title: `B only ${suffix}` });
      const { data } = await service.list(recruiterA, { limit: 100 });

      expect(data.every((j) => j.companyId === companyA)).toBe(true);
      expect(data.some((j) => j.title === `B only ${suffix}`)).toBe(false);
    });

    it('an ADMIN sees all jobs in their own tenant', async () => {
      const { data } = await service.list(adminA, { limit: 100 });
      expect(data.length).toBeGreaterThan(0);
      expect(data.every((j) => j.companyId === companyA)).toBe(true);
    });

    it('§24.2: a HIRING MANAGER sees ONLY assigned jobs', async () => {
      const assigned = await service.create(recruiterA, { title: `HM yes ${suffix}` });
      await service.create(recruiterA, { title: `HM no ${suffix}` });

      await prisma.jobAssignment.create({
        data: { jobId: assigned.id, userId: hmAssigned.id },
      });

      const { data } = await service.list(hmAssigned, { limit: 100 });

      expect(data.map((j) => j.id)).toEqual([assigned.id]);
      expect(data.some((j) => j.title === `HM no ${suffix}`)).toBe(false);
    });

    it('an UNASSIGNED hiring manager sees an empty list, not the tenant', async () => {
      const { data } = await service.list(hmUnassigned, { limit: 100 });
      expect(data).toEqual([]);
    });
  });

  // =========================================================================
  // Listing behaviour
  // =========================================================================
  describe('list — filtering and cursor pagination (PRD §23.1)', () => {
    it('filters by status', async () => {
      const job = await service.create(recruiterA, { title: `Filter ${suffix}` });
      await service.update(recruiterA, job.id, { status: JobStatus.PUBLISHED });

      const { data } = await service.list(recruiterA, {
        status: JobStatus.PUBLISHED,
        limit: 100,
      });

      expect(data.length).toBeGreaterThan(0);
      expect(data.every((j) => j.status === JobStatus.PUBLISHED)).toBe(true);
    });

    it('filters by department', async () => {
      await service.create(recruiterA, { title: `Dept ${suffix}`, department: 'Finance' });
      const { data } = await service.list(recruiterA, { department: 'Finance', limit: 100 });

      expect(data.length).toBeGreaterThan(0);
      expect(data.every((j) => j.department === 'Finance')).toBe(true);
    });

    it('paginates by cursor without repeating or skipping rows', async () => {
      const first = await service.list(recruiterA, { limit: 2 });
      expect(first.data).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await service.list(recruiterA, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });

      const overlap = first.data.filter((a) => second.data.some((b) => b.id === a.id));
      expect(overlap).toEqual([]);
    });

    it('reports nextCursor as null on the final page', async () => {
      const { nextCursor } = await service.list(recruiterA, { limit: 500 });
      expect(nextCursor).toBeNull();
    });
  });
});
