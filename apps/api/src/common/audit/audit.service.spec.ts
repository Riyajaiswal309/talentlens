import { ConfigService } from '@nestjs/config';
import { AuditActorType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from './audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Integration test — requires the M2.2 database.
 *
 * Start it with `docker compose up -d` from the repo root. These assertions
 * cannot be made against a mock: the whole point is that the DATABASE, not
 * application code, refuses to mutate an audit record (PRD §17.3).
 */
const APP_URL =
  process.env.APP_DATABASE_URL ??
  'postgresql://talentlens_app:talentlens_app_dev@localhost:5432/talentlens?schema=public';

describe('AuditService (integration, PRD §17.3 append-only)', () => {
  let prisma: PrismaService;
  let service: AuditService;
  let actorId: string;
  let companyId: string;
  const correlationId = `test-${randomUUID()}`;

  beforeAll(async () => {
    const config = {
      get: (key: string) => (key === 'APP_DATABASE_URL' ? APP_URL : undefined),
    } as unknown as ConfigService;

    prisma = new PrismaService(config);
    await prisma.$connect();
    service = new AuditService(prisma);

    // Any seeded user works as the actor; actor_id is a NOT NULL FK.
    const user = await prisma.users.findFirst();
    if (!user) throw new Error('No seeded users found. Run `pnpm prisma:seed` first.');
    actorId = user.id;
    // M2.10 — every new audit record carries its tenant.
    companyId = user.companyId;
  });

  afterAll(async () => {
    // Cleanup runs as the OWNER, because the application role is not
    // permitted to delete audit rows — which is precisely what we assert.
    const ownerUrl =
      process.env.DATABASE_URL ??
      'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';
    const owner = new PrismaService({ get: () => ownerUrl } as unknown as ConfigService);
    await owner.$connect();
    await owner.auditLog.deleteMany({ where: { correlationId } });
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  it('writes an audit record through the restricted application role', async () => {
    const resourceId = randomUUID();

    await service.record({
      companyId,
      actorId,
      actorType: AuditActorType.USER,
      action: 'job.published',
      resourceType: 'job',
      resourceId,
      correlationId,
      beforeState: { status: 'DRAFT' },
      afterState: { status: 'PUBLISHED' },
    });

    const row = await prisma.auditLog.findFirst({ where: { resourceId } });

    expect(row).not.toBeNull();
    expect(row?.action).toBe('job.published');
    expect(row?.correlationId).toBe(correlationId);
    expect(row?.beforeState).toEqual({ status: 'DRAFT' });
    expect(row?.afterState).toEqual({ status: 'PUBLISHED' });
  });

  it('DATABASE refuses UPDATE through the application role', async () => {
    const resourceId = randomUUID();
    await service.record({
      companyId,
      actorId,
      actorType: AuditActorType.USER,
      action: 'job.published',
      resourceType: 'job',
      resourceId,
      correlationId,
    });

    await expect(
      prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'tampered'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('DATABASE refuses DELETE through the application role', async () => {
    await expect(prisma.$executeRawUnsafe(`DELETE FROM audit_logs`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  /**
   * APPROVED RESOLUTION of the audit-actor PRD GAP (8 Aug 2026).
   *
   * Asserted against the real database rather than a mock: the guarantee is a
   * CHECK constraint, so only Postgres can confirm it holds.
   */
  describe('public actions (FR2.1 application.submitted)', () => {
    it('PERSISTS actor_type = PUBLIC with actor_id = NULL', async () => {
      const resourceId = randomUUID();

      await service.record({
        companyId,
        actorId: null,
        actorType: AuditActorType.PUBLIC,
        action: 'application.submitted',
        resourceType: 'application',
        resourceId,
        correlationId,
        afterState: { currentStage: 'Applied' },
      });

      const row = await prisma.auditLog.findFirst({ where: { resourceId } });

      expect(row).not.toBeNull();
      expect(row?.actorType).toBe(AuditActorType.PUBLIC);
      expect(row?.actorId).toBeNull();
      expect(row?.action).toBe('application.submitted');
      expect(row?.correlationId).toBe(correlationId);
    });

    it('PERSISTS actor_type = USER with a real actor_id', async () => {
      const resourceId = randomUUID();

      await service.record({
        companyId,
        actorId,
        actorType: AuditActorType.USER,
        action: 'job.created',
        resourceType: 'job',
        resourceId,
        correlationId,
      });

      const row = await prisma.auditLog.findFirst({ where: { resourceId } });

      expect(row?.actorType).toBe(AuditActorType.USER);
      expect(row?.actorId).toBe(actorId);
    });

    it('rejects USER with no actorId before reaching the database', async () => {
      await expect(
        service.record({
          companyId,
          actorId: null,
          actorType: AuditActorType.USER,
          action: 'job.created',
          resourceType: 'job',
          resourceId: randomUUID(),
          correlationId,
        }),
      ).rejects.toThrow(/USER but carries no actorId/);
    });

    it('rejects PUBLIC carrying an actorId before reaching the database', async () => {
      await expect(
        service.record({
          companyId,
          actorId,
          actorType: AuditActorType.PUBLIC,
          action: 'application.submitted',
          resourceType: 'application',
          resourceId: randomUUID(),
          correlationId,
        }),
      ).rejects.toThrow(/PUBLIC but carries an actorId/);
    });

    it('the DATABASE itself rejects a bad pairing, not just the service', async () => {
      // Bypasses AuditService entirely to prove the CHECK constraint is the
      // real authority — a future code path cannot write a misleading row.
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO audit_logs (id, actor_id, actor_type, action, resource_type, resource_id, correlation_id)
           VALUES (gen_random_uuid(), NULL, 'USER', 'bad', 'x', gen_random_uuid(), $1)`,
          correlationId,
        ),
      ).rejects.toThrow(/audit_logs_actor_pairing/);
    });
  });

  it('exposes no update or delete method on the service', () => {
    expect((service as unknown as Record<string, unknown>)['update']).toBeUndefined();
    expect((service as unknown as Record<string, unknown>)['delete']).toBeUndefined();
  });
});
