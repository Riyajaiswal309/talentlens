import { Controller, Delete, Get, Param, ParseEnumPipe, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { type CalendarConnection, CalendarProvider, UserRole } from '@prisma/client';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { CalendarConnectionsService, toAuditState } from './calendar-connections.service';

/**
 * Safe metadata only (D36, D45).
 *
 * A separate declared type rather than the entity, following the same rule
 * `PublicJobResponse` states: a column added to `calendar_connections` later
 * cannot leak by being picked up automatically. There is no field here for a
 * token, ciphertext, key or any encryption metadata, and adding one would be
 * a visible change to this interface rather than an accident.
 */
interface CalendarConnectionResponse {
  id: string;
  provider: string;
  accountIdentifier: string;
  status: string;
  expiresAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toResponse(connection: CalendarConnection): CalendarConnectionResponse {
  return {
    id: connection.id,
    provider: connection.provider,
    accountIdentifier: connection.accountIdentifier,
    status: connection.status,
    expiresAt: connection.expiresAt?.toISOString() ?? null,
    disconnectedAt: connection.disconnectedAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

/**
 * FR6.1 Phase 1 — calendar connection management.
 *
 * WHAT IS DELIBERATELY ABSENT: there is no connect endpoint. D40 puts consent
 * under the interviewer's own session via a provider OAuth redirect, and no
 * Google or Microsoft adapter exists yet. The two ways to ship a "connect"
 * route today would both be worse than shipping none:
 *
 *   - a route that accepts a refresh token from the client would let any
 *     caller plant a credential of their choosing, and
 *   - a route that fabricates a connection without a provider exchange would
 *     record an `account_identifier` nothing authorised.
 *
 * So the connect half waits for the adapter. `CalendarConnectionsService.
 * authorise()` is the seam it will call, and it is unreachable from HTTP.
 *
 * Disconnect and read ARE provider-independent — removing a credential this
 * system holds needs nobody's permission but ours — so they ship now.
 *
 * CANDIDATES ARE ABSENT FROM EVERY ROUTE (D44). They are never interviewers,
 * and §24.2 grants them nothing here.
 */
@Controller('calendar/connections')
export class CalendarConnectionsController {
  constructor(private readonly connections: CalendarConnectionsService) {}

  /**
   * GET /v1/calendar/connections — the caller's own connections.
   *
   * Own only. There is no route that lists another user's connections: D34
   * makes a connection the interviewer's, and an administrator's legitimate
   * need is to *remove* one, not to browse it.
   */
  @Get()
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'List the calling user’s own calendar connections (FR6.1)' })
  async listOwn(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ data: CalendarConnectionResponse[] }> {
    const connections = await this.connections.listOwn(user);
    return { data: connections.map(toResponse) };
  }

  /**
   * DELETE /v1/calendar/connections/:provider — disconnect one's own calendar.
   *
   * Audited as `calendar.disconnected` (D43, C4). The state carries provider
   * and account identifier only; the credential is cleared by the service and
   * never appears in the record.
   */
  @Delete(':provider')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @Audit({ action: 'calendar.disconnected', resourceType: 'calendar_connection' })
  @ApiOperation({ summary: 'Disconnect the calling user’s own calendar (FR6.1, D44)' })
  async disconnectOwn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider', new ParseEnumPipe(CalendarProvider)) provider: CalendarProvider,
    @Req() req: RequestContext,
  ): Promise<CalendarConnectionResponse> {
    const before = await this.connections.disconnectOwn(user, provider);

    // resourceId is taken from the `id` in the response body — the
    // interceptor's documented fallback when a route carries no `:id` param.
    req.auditState = { before: toAuditState(before), after: null };

    return toResponse(before);
  }

  /**
   * DELETE /v1/calendar/connections/users/:userId/:provider — Administrator
   * disconnects another user's calendar (D44).
   *
   * Admin only, and the refusal for a user outside the tenant is 404 rather
   * than 403 (BR-06). The acting administrator is the audit actor, matching
   * how `auth.sessions_revoked` already attributes an action taken on someone
   * else's behalf.
   */
  @Delete('users/:userId/:provider')
  @Roles(UserRole.ADMIN)
  @Audit({ action: 'calendar.disconnected', resourceType: 'calendar_connection' })
  @ApiOperation({ summary: 'Administrator disconnects another user’s calendar (FR6.1, D44)' })
  async disconnectForUser(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('provider', new ParseEnumPipe(CalendarProvider)) provider: CalendarProvider,
    @Req() req: RequestContext,
  ): Promise<CalendarConnectionResponse> {
    const before = await this.connections.disconnectForUser(admin, userId, provider);

    // resourceId is taken from the `id` in the response body — the
    // interceptor's documented fallback when a route carries no `:id` param.
    req.auditState = { before: toAuditState(before), after: null };

    return toResponse(before);
  }
}
