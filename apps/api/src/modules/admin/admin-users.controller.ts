import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { UserRole, type Users } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { AdminUsersService } from './admin-users.service';
import { ChangeRoleDto, CreateUserDto, ListUsersQueryDto } from './dto/admin-user.dto';

/** Phase 1 AD-02 — user table with role and last-active. */
interface AdminUserResponse {
  id: string;
  email: string;
  role: string;
  /** Gap 5: an account with no credential has been invited, not activated. */
  invited: boolean;
  createdAt: string;
  lastActiveAt: string | null;
}

function toResponse(user: Users): AdminUserResponse {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    invited: user.passwordHash === null,
    createdAt: user.createdAt.toISOString(),
    lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
  };
}

/**
 * FR8.1 / FR8.4 — user, role and session administration
 * (Handoff §B rows 20–23, Gaps 5 and 6, Phase 1 AD-02 and AD-06).
 *
 * Administrator only, per PRD §24.2 "Manage users and roles — Admin ✓".
 * Every route is tenant-scoped in the service and refuses with 404 rather
 * than 403, so an administrator cannot discover which ids exist elsewhere.
 */
@ApiTags('admin')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List users in the caller’s tenant (FR8.1)' })
  async list(
    @CurrentUser() admin: AuthenticatedUser,
    @Query() query: ListUsersQueryDto,
  ): Promise<{ data: AdminUserResponse[]; nextCursor: string | null }> {
    const { data, nextCursor } = await this.users.list(admin, query);
    return { data: data.map(toResponse), nextCursor };
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @Audit({ action: 'admin.user_invited', resourceType: 'user' })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Invite a user (FR8.1). CANDIDATE is not assignable.' })
  async create(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreateUserDto,
    @Req() req: RequestContext,
  ): Promise<AdminUserResponse> {
    const user = await this.users.create(admin, dto);

    // No :id on the route — point the audit record at the new user.
    req.params = { ...req.params, id: user.id };
    req.auditState = { before: null, after: { email: user.email, role: user.role } };

    return toResponse(user);
  }

  @Patch(':id/role')
  @Roles(UserRole.ADMIN)
  @Audit({ action: 'admin.role_changed', resourceType: 'user' })
  @ApiOperation({ summary: 'Change a role (FR8.1). Last administrator cannot be demoted.' })
  async changeRole(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
    @Req() req: RequestContext,
  ): Promise<AdminUserResponse> {
    const { before, after } = await this.users.changeRole(admin, id, dto);

    req.auditState = {
      before: { email: before.email, role: before.role },
      after: { email: after.email, role: after.role },
    };

    return toResponse(after);
  }

  @Delete(':id/sessions')
  @Roles(UserRole.ADMIN)
  @Audit({ action: 'auth.sessions_revoked', resourceType: 'user' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke every refresh token for a user (FR8.4)',
    description:
      'Access tokens already issued remain valid until they expire (≤15 min, PRD §24.1).',
  })
  async revokeSessions(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestContext,
  ): Promise<{ revokedCount: number; revokedAt: string }> {
    const result = await this.users.revokeSessions(admin, id);

    req.auditState = {
      before: null,
      after: { revokedCount: result.revokedCount, targetUserId: id },
    };

    return { revokedCount: result.revokedCount, revokedAt: result.revokedAt.toISOString() };
  }
}
