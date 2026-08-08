import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CandidateOwnershipGuard } from './candidate-ownership.guard';
import { JobAssignmentGuard } from './job-assignment.guard';
import { RolesGuard } from './roles.guard';
import { TenantGuard } from './tenant.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  CANDIDATE_OWNED_KEY,
  JOB_SCOPED_KEY,
  type CandidateOwnedMetadata,
} from '../decorators/resource-access.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../types/authenticated-request';

/**
 * Authorization integration tests — require the M2.2/M2.5 database.
 *
 * These run against real rows because the rules being verified ARE database
 * relationships: job_assignments for the Hiring Manager restriction, and
 * candidates.user_id for candidate ownership. Mocking the queries would test
 * the mock, not the rule.
 *
 * Fixtures build TWO tenants so cross-tenant leakage (risk R-09) is
 * exercised rather than assumed.
 */
const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

function makeContext(user: AuthenticatedUser | undefined, params: Record<string, string> = {}) {
  const request = { user, params } as unknown as RequestContext;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function principal(overrides: Partial<AuthenticatedUser>): AuthenticatedUser {
  return {
    id: 'unset',
    email: 'unset@talentlens.local',
    role: UserRole.RECRUITER,
    companyId: 'unset',
    ...overrides,
  };
}

describe('Authorization (PRD §24.2, BR-06, decision B1)', () => {
  let prisma: PrismaService;
  let reflector: Reflector;
  let ownershipGuard: CandidateOwnershipGuard;
  let jobGuard: JobAssignmentGuard;

  const suffix = randomUUID().slice(0, 8);
  const ids = {
    companyA: '',
    companyB: '',
    recruiterA: '',
    hmAssignedA: '',
    hmUnassignedA: '',
    adminA: '',
    recruiterB: '',
    candidateUserA: '',
    candidateUserOther: '',
    jobA: '',
    jobB: '',
    candidateA: '',
    candidateOther: '',
    candidateNoAccount: '',
    applicationA: '',
    applicationOther: '',
  };

  beforeAll(async () => {
    prisma = new PrismaService({ get: () => OWNER_URL } as unknown as ConfigService);
    await prisma.$connect();
    reflector = new Reflector();
    ownershipGuard = new CandidateOwnershipGuard(reflector, prisma);
    jobGuard = new JobAssignmentGuard(reflector, prisma);

    // --- Two tenants -------------------------------------------------------
    const companyA = await prisma.company.create({
      data: { name: `Test A ${suffix}`, dataRegion: 'test' },
    });
    const companyB = await prisma.company.create({
      data: { name: `Test B ${suffix}`, dataRegion: 'test' },
    });
    ids.companyA = companyA.id;
    ids.companyB = companyB.id;

    const mkUser = async (companyId: string, role: UserRole, tag: string) =>
      prisma.users.create({
        data: { companyId, role, email: `${tag}.${suffix}@test.local` },
      });

    ids.recruiterA = (await mkUser(companyA.id, UserRole.RECRUITER, 'recruiter-a')).id;
    ids.adminA = (await mkUser(companyA.id, UserRole.ADMIN, 'admin-a')).id;
    ids.hmAssignedA = (await mkUser(companyA.id, UserRole.HIRING_MANAGER, 'hm-assigned')).id;
    ids.hmUnassignedA = (await mkUser(companyA.id, UserRole.HIRING_MANAGER, 'hm-unassigned')).id;
    ids.recruiterB = (await mkUser(companyB.id, UserRole.RECRUITER, 'recruiter-b')).id;
    ids.candidateUserA = (await mkUser(companyA.id, UserRole.CANDIDATE, 'cand-a')).id;
    ids.candidateUserOther = (await mkUser(companyA.id, UserRole.CANDIDATE, 'cand-other')).id;

    // --- Jobs, one per tenant ---------------------------------------------
    const jobA = await prisma.job.create({
      data: { companyId: companyA.id, createdBy: ids.recruiterA, title: `Job A ${suffix}` },
    });
    const jobB = await prisma.job.create({
      data: { companyId: companyB.id, createdBy: ids.recruiterB, title: `Job B ${suffix}` },
    });
    ids.jobA = jobA.id;
    ids.jobB = jobB.id;

    // Decision B1 — only ONE of the two hiring managers is assigned.
    await prisma.jobAssignment.create({
      data: { jobId: jobA.id, userId: ids.hmAssignedA },
    });

    // --- Candidates: linked, linked-to-someone-else, and unlinked ---------
    const candidateA = await prisma.candidate.create({
      data: {
        fullName: 'Candidate A',
        email: `cand-a.${suffix}@test.local`,
        userId: ids.candidateUserA,
      },
    });
    const candidateOther = await prisma.candidate.create({
      data: {
        fullName: 'Candidate Other',
        email: `cand-other.${suffix}@test.local`,
        userId: ids.candidateUserOther,
      },
    });
    // Rule 1 of the approved resolution: a profile with NO login account.
    const candidateNoAccount = await prisma.candidate.create({
      data: { fullName: 'No Account', email: `cand-none.${suffix}@test.local` },
    });
    ids.candidateA = candidateA.id;
    ids.candidateOther = candidateOther.id;
    ids.candidateNoAccount = candidateNoAccount.id;

    const applicationA = await prisma.application.create({
      data: { jobId: jobA.id, candidateId: candidateA.id, currentStage: 'Applied' },
    });
    const applicationOther = await prisma.application.create({
      data: { jobId: jobA.id, candidateId: candidateOther.id, currentStage: 'Applied' },
    });
    ids.applicationA = applicationA.id;
    ids.applicationOther = applicationOther.id;
  });

  afterAll(async () => {
    /*
     * Order matters. applications.candidate_id is ON DELETE RESTRICT, so
     * candidates cannot be removed while an application references them.
     * Deleting the companies first cascades jobs -> applications, which
     * releases the candidates.
     */
    await prisma.company.deleteMany({ where: { id: { in: [ids.companyA, ids.companyB] } } });
    await prisma.candidate.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.$disconnect();
  });

  // =========================================================================
  // PRD §24.2 permission matrix
  // =========================================================================
  describe('RolesGuard — PRD §24.2 Table 24.1', () => {
    const guard = () => new RolesGuard(reflector);

    function requireRoles(roles: UserRole[] | undefined) {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
    }

    const matrix: Array<{ action: string; allowed: UserRole[] }> = [
      { action: 'Create / edit jobs', allowed: [UserRole.RECRUITER, UserRole.ADMIN] },
      { action: 'Override AI score', allowed: [UserRole.RECRUITER, UserRole.ADMIN] },
      { action: 'Move pipeline stage', allowed: [UserRole.RECRUITER, UserRole.ADMIN] },
      {
        action: 'Submit scorecard',
        allowed: [UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN],
      },
      { action: 'Enable / disable AI scoring', allowed: [UserRole.ADMIN] },
      { action: 'Export audit log', allowed: [UserRole.ADMIN] },
      { action: 'Manage users and roles', allowed: [UserRole.ADMIN] },
    ];

    it.each(matrix)('$action — only the permitted roles pass', ({ allowed }) => {
      for (const role of Object.values(UserRole)) {
        requireRoles(allowed);
        const ctx = makeContext(principal({ role, companyId: ids.companyA }));

        if (allowed.includes(role)) {
          expect(guard().canActivate(ctx)).toBe(true);
        } else {
          expect(() => guard().canActivate(ctx)).toThrow(ForbiddenException);
        }
      }
    });

    it('BR-04: RECRUITER cannot toggle AI scoring, ADMIN can', () => {
      requireRoles([UserRole.ADMIN]);
      expect(() =>
        guard().canActivate(makeContext(principal({ role: UserRole.RECRUITER }))),
      ).toThrow(ForbiddenException);

      requireRoles([UserRole.ADMIN]);
      expect(guard().canActivate(makeContext(principal({ role: UserRole.ADMIN })))).toBe(true);
    });
  });

  // =========================================================================
  // Tenant isolation
  // =========================================================================
  describe('TenantGuard + JobAssignmentGuard — tenant isolation (R-09)', () => {
    const tenantGuard = new TenantGuard();

    function scopeJob() {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: unknown) => (key === JOB_SCOPED_KEY ? {} : undefined));
    }

    it('requires every authenticated principal to carry a tenant', () => {
      expect(() => tenantGuard.canActivate(makeContext(principal({ companyId: '' })))).toThrow(
        ForbiddenException,
      );
    });

    it('a RECRUITER cannot reach another tenant’s job — 404, not 403', async () => {
      scopeJob();
      const ctx = makeContext(
        principal({ id: ids.recruiterA, role: UserRole.RECRUITER, companyId: ids.companyA }),
        { id: ids.jobB },
      );
      await expect(jobGuard.canActivate(ctx)).rejects.toThrow(NotFoundException);
    });

    it('a RECRUITER reaches their own tenant’s job', async () => {
      scopeJob();
      const ctx = makeContext(
        principal({ id: ids.recruiterA, role: UserRole.RECRUITER, companyId: ids.companyA }),
        { id: ids.jobA },
      );
      await expect(jobGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('an ADMIN sees every job in their own tenant but not another’s', async () => {
      scopeJob();
      await expect(
        jobGuard.canActivate(
          makeContext(
            principal({ id: ids.adminA, role: UserRole.ADMIN, companyId: ids.companyA }),
            {
              id: ids.jobA,
            },
          ),
        ),
      ).resolves.toBe(true);

      scopeJob();
      await expect(
        jobGuard.canActivate(
          makeContext(
            principal({ id: ids.adminA, role: UserRole.ADMIN, companyId: ids.companyA }),
            {
              id: ids.jobB,
            },
          ),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('a non-existent job id is 404, indistinguishable from a foreign one', async () => {
      scopeJob();
      const ctx = makeContext(
        principal({ id: ids.recruiterA, role: UserRole.RECRUITER, companyId: ids.companyA }),
        { id: randomUUID() },
      );
      await expect(jobGuard.canActivate(ctx)).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // Hiring Manager — assigned jobs only (decision B1)
  // =========================================================================
  describe('JobAssignmentGuard — HM "assigned jobs only" (PRD §24.2)', () => {
    function scopeJob() {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: unknown) => (key === JOB_SCOPED_KEY ? {} : undefined));
    }

    it('an ASSIGNED hiring manager reaches the job', async () => {
      scopeJob();
      const ctx = makeContext(
        principal({
          id: ids.hmAssignedA,
          role: UserRole.HIRING_MANAGER,
          companyId: ids.companyA,
        }),
        { id: ids.jobA },
      );
      await expect(jobGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('an UNASSIGNED hiring manager in the SAME tenant gets 404', async () => {
      scopeJob();
      const ctx = makeContext(
        principal({
          id: ids.hmUnassignedA,
          role: UserRole.HIRING_MANAGER,
          companyId: ids.companyA,
        }),
        { id: ids.jobA },
      );
      await expect(jobGuard.canActivate(ctx)).rejects.toThrow(NotFoundException);
    });

    it('revoking the assignment immediately removes access', async () => {
      const created = await prisma.jobAssignment.create({
        data: { jobId: ids.jobA, userId: ids.hmUnassignedA },
      });

      scopeJob();
      await expect(
        jobGuard.canActivate(
          makeContext(
            principal({
              id: ids.hmUnassignedA,
              role: UserRole.HIRING_MANAGER,
              companyId: ids.companyA,
            }),
            { id: ids.jobA },
          ),
        ),
      ).resolves.toBe(true);

      await prisma.jobAssignment.delete({ where: { id: created.id } });

      scopeJob();
      await expect(
        jobGuard.canActivate(
          makeContext(
            principal({
              id: ids.hmUnassignedA,
              role: UserRole.HIRING_MANAGER,
              companyId: ids.companyA,
            }),
            { id: ids.jobA },
          ),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // Candidate ownership (BR-06) — the approved candidate-identity resolution
  // =========================================================================
  describe('CandidateOwnershipGuard — BR-06', () => {
    function ownApplication(metadata: CandidateOwnedMetadata = { resource: 'application' }) {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: unknown) => (key === CANDIDATE_OWNED_KEY ? metadata : undefined));
    }

    it('a candidate reaches their OWN application', async () => {
      ownApplication();
      const ctx = makeContext(
        principal({ id: ids.candidateUserA, role: UserRole.CANDIDATE, companyId: ids.companyA }),
        { id: ids.applicationA },
      );
      await expect(ownershipGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('a candidate CANNOT reach another candidate’s application — 404, not 403', async () => {
      ownApplication();
      const ctx = makeContext(
        principal({ id: ids.candidateUserA, role: UserRole.CANDIDATE, companyId: ids.companyA }),
        { id: ids.applicationOther },
      );
      await expect(ownershipGuard.canActivate(ctx)).rejects.toThrow(NotFoundException);
    });

    it('PRD §26: the refusal is NotFound, never Forbidden (no existence disclosure)', async () => {
      ownApplication();
      const ctx = makeContext(
        principal({ id: ids.candidateUserA, role: UserRole.CANDIDATE, companyId: ids.companyA }),
        { id: ids.applicationOther },
      );
      await expect(ownershipGuard.canActivate(ctx)).rejects.not.toThrow(ForbiddenException);
    });

    it('a foreign application and a non-existent one are indistinguishable', async () => {
      ownApplication();
      const foreign = ownershipGuard
        .canActivate(
          makeContext(
            principal({
              id: ids.candidateUserA,
              role: UserRole.CANDIDATE,
              companyId: ids.companyA,
            }),
            { id: ids.applicationOther },
          ),
        )
        .catch((e: Error) => e.constructor.name);

      ownApplication();
      const missing = ownershipGuard
        .canActivate(
          makeContext(
            principal({
              id: ids.candidateUserA,
              role: UserRole.CANDIDATE,
              companyId: ids.companyA,
            }),
            { id: randomUUID() },
          ),
        )
        .catch((e: Error) => e.constructor.name);

      expect(await foreign).toBe(await missing);
    });

    it('a CANDIDATE user with NO linked profile owns nothing (rule 4)', async () => {
      const orphan = await prisma.users.create({
        data: {
          companyId: ids.companyA,
          role: UserRole.CANDIDATE,
          email: `orphan.${suffix}@test.local`,
        },
      });

      ownApplication();
      const ctx = makeContext(
        principal({ id: orphan.id, role: UserRole.CANDIDATE, companyId: ids.companyA }),
        { id: ids.applicationA },
      );
      await expect(ownershipGuard.canActivate(ctx)).rejects.toThrow(NotFoundException);

      await prisma.users.delete({ where: { id: orphan.id } });
    });

    it('a candidate profile may exist with NO account (rule 1) — unaffected', async () => {
      const unlinked = await prisma.candidate.findUnique({
        where: { id: ids.candidateNoAccount },
        select: { userId: true },
      });
      expect(unlinked?.userId).toBeNull();
    });

    it('one account cannot claim a second candidate profile (unique user_id)', async () => {
      await expect(
        prisma.candidate.create({
          data: {
            fullName: 'Duplicate Claim',
            email: `dup.${suffix}@test.local`,
            userId: ids.candidateUserA,
          },
        }),
      ).rejects.toThrow();
    });

    it('a candidate may address their own profile but not another’s', async () => {
      ownApplication({ resource: 'candidate' });
      await expect(
        ownershipGuard.canActivate(
          makeContext(
            principal({
              id: ids.candidateUserA,
              role: UserRole.CANDIDATE,
              companyId: ids.companyA,
            }),
            { id: ids.candidateA },
          ),
        ),
      ).resolves.toBe(true);

      ownApplication({ resource: 'candidate' });
      await expect(
        ownershipGuard.canActivate(
          makeContext(
            principal({
              id: ids.candidateUserA,
              role: UserRole.CANDIDATE,
              companyId: ids.companyA,
            }),
            { id: ids.candidateOther },
          ),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('BR-05: an ERASED candidate cannot reach their own data', async () => {
      await prisma.candidate.update({
        where: { id: ids.candidateA },
        data: { deletedAt: new Date() },
      });

      ownApplication();
      await expect(
        ownershipGuard.canActivate(
          makeContext(
            principal({
              id: ids.candidateUserA,
              role: UserRole.CANDIDATE,
              companyId: ids.companyA,
            }),
            { id: ids.applicationA },
          ),
        ),
      ).rejects.toThrow(NotFoundException);

      await prisma.candidate.update({
        where: { id: ids.candidateA },
        data: { deletedAt: null },
      });
    });

    it('RECRUITER and ADMIN are not constrained by candidate ownership', async () => {
      for (const role of [UserRole.RECRUITER, UserRole.ADMIN, UserRole.HIRING_MANAGER]) {
        ownApplication();
        const ctx = makeContext(principal({ role, companyId: ids.companyA }), {
          id: ids.applicationOther,
        });
        await expect(ownershipGuard.canActivate(ctx)).resolves.toBe(true);
      }
    });

    it('routes without @CandidateOwned() are untouched', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
      const ctx = makeContext(
        principal({ id: ids.candidateUserA, role: UserRole.CANDIDATE, companyId: ids.companyA }),
        { id: ids.applicationOther },
      );
      await expect(ownershipGuard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  // Keeps ROLES_KEY referenced so the matrix above stays tied to the decorator.
  it('uses the ROLES_KEY metadata contract', () => {
    expect(ROLES_KEY).toBe('roles');
  });
});
