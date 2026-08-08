import { ConfigService } from '@nestjs/config';
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
      actorId,
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
      actorId,
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

  it('exposes no update or delete method on the service', () => {
    expect((service as unknown as Record<string, unknown>)['update']).toBeUndefined();
    expect((service as unknown as Record<string, unknown>)['delete']).toBeUndefined();
  });
});
