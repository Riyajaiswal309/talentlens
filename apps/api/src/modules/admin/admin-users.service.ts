import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, UserRole, type Users } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RefreshTokenStore } from '../auth/refresh-token.store';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import type { ChangeRoleDto, CreateUserDto, ListUsersQueryDto } from './dto/admin-user.dto';

const DEFAULT_PAGE_SIZE = 25;

export interface RevocationResult {
  revokedCount: number;
  revokedAt: Date;
}

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: RefreshTokenStore,
  ) {}

  /** Gap 5 — every refusal is scoped to the caller's tenant. */
  private async findInTenant(admin: AuthenticatedUser, userId: string): Promise<Users> {
    const user = await this.prisma.users.findFirst({
      where: { id: userId, companyId: admin.companyId },
    });
    // 404, not 403: a 403 would confirm the id exists in another tenant.
    if (!user) throw new NotFoundException();
    return user;
  }

  async list(
    admin: AuthenticatedUser,
    query: ListUsersQueryDto,
  ): Promise<{ data: Users[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const rows = await this.prisma.users.findMany({
      where: {
        companyId: admin.companyId,
        ...(query.role ? { role: query.role as unknown as UserRole } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    return { data, nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null };
  }

  /**
   * Gap 5 — invite a user.
   *
   * APPROVED (9 Aug 2026): no status column. An invited account is one with
   * no `password_hash` — the column is already nullable for SSO accounts, and
   * AuthService cannot authenticate a user without one, so such a record can
   * exist but cannot log in. Email delivery is not built.
   */
  async create(admin: AuthenticatedUser, dto: CreateUserDto): Promise<Users> {
    try {
      return await this.prisma.users.create({
        data: {
          companyId: admin.companyId,
          email: dto.email.toLowerCase().trim(),
          role: dto.role as unknown as UserRole,
          // Invited: no credential yet, so no way in until one is set.
          passwordHash: null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // users has UNIQUE (company_id, email) — unique per tenant, not global.
        throw new ConflictException('A user with that email already exists');
      }
      throw error;
    }
  }

  /**
   * Gap 5 — change a role.
   *
   * LAST-ADMINISTRATOR GUARD: demoting the final ADMIN would strand the tenant
   * with no one able to reach FR8.2 or FR8.3 — an unrecoverable state, since
   * nothing else can promote a replacement.
   */
  async changeRole(
    admin: AuthenticatedUser,
    userId: string,
    dto: ChangeRoleDto,
  ): Promise<{ before: Users; after: Users }> {
    const before = await this.findInTenant(admin, userId);
    const nextRole = dto.role as unknown as UserRole;

    if (before.role === UserRole.ADMIN && nextRole !== UserRole.ADMIN) {
      await this.assertNotLastAdmin(admin.companyId);
    }

    const after = await this.prisma.users.update({
      where: { id: before.id },
      data: { role: nextRole },
    });

    return { before, after };
  }

  private async assertNotLastAdmin(companyId: string): Promise<void> {
    const admins = await this.prisma.users.count({
      where: { companyId, role: UserRole.ADMIN },
    });

    if (admins <= 1) {
      throw new UnprocessableEntityException(
        'This is the last administrator. Promote another administrator first',
      );
    }
  }

  /**
   * FR8.4 / Gap 6 — revoke every refresh token for a user, immediately.
   *
   * Reuses RefreshTokenStore from M2.4 rather than reaching into Redis:
   * revocation and issuance must agree on the key layout, and they only do
   * that by sharing one implementation.
   *
   * SELF-REVOCATION GUARD: an Administrator cannot cut their own session off
   * mid-task through this route; `POST /v1/auth/logout` is for that.
   *
   * Already-issued ACCESS tokens stay valid until they expire (≤15 min). That
   * is a property of stateless JWT (PRD §24.1, decision D7), not a defect: a
   * deny-list would add a Redis read to every request against NFR1.
   */
  async revokeSessions(admin: AuthenticatedUser, userId: string): Promise<RevocationResult> {
    if (admin.id === userId) {
      throw new UnprocessableEntityException(
        'Use logout to end your own session; this revokes another user’s',
      );
    }

    const user = await this.findInTenant(admin, userId);
    const revokedCount = await this.sessions.revokeAll(user.id);

    return { revokedCount, revokedAt: new Date() };
  }

  /** Live refresh-token count, for AD-06's session list. */
  countSessions(userId: string): Promise<number> {
    return this.sessions.countLive(userId);
  }
}
