import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { CalendarProvider, UserRole } from '@prisma/client';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { CalendarConnectionsService, toAuditState } from './calendar-connections.service';
import { CalendarProviderRegistry } from './calendar-provider.registry';
import { OAuthStateStore } from './oauth-state.store';
import { CompleteConnectionDto } from './dto/complete-connection.dto';
import { ProviderCredentialError, ProviderUnavailableError } from './providers/provider-adapter';

/**
 * FR6.1 consent — the interviewer connects their own calendar (D40, D44).
 *
 * WHY BOTH ROUTES ARE AUTHENTICATED, AND WHY THERE IS NO REDIRECT HANDLER.
 * D40 requires consent under the interviewer's own session, and the repository
 * forbids `@Public()` on calendar endpoints. A provider redirect cannot carry
 * a Bearer token, so the provider is configured to redirect to the FRONTEND,
 * which reads `code` and `state` from the query string and posts them here
 * with the session it already has. That keeps both halves inside the
 * authenticated session without a public callback and without D5's token
 * pattern, which D40 explicitly rejects.
 *
 * THE STATE IS THE CSRF DEFENCE AND THE SECOND IDENTITY CHECK. It is minted
 * server-side against the initiating user, consumed exactly once, and the
 * completing caller must be that same user — so a captured `code` cannot be
 * replayed by anyone, including another authenticated user.
 *
 * CANDIDATES ARE ABSENT FROM BOTH ROUTES (D44). Nobody may connect a calendar
 * on behalf of another user: there is no user parameter on either route.
 */
@Controller('calendar/connections')
export class CalendarOAuthController {
  constructor(
    private readonly connections: CalendarConnectionsService,
    private readonly registry: CalendarProviderRegistry,
    private readonly states: OAuthStateStore,
  ) {}

  /**
   * POST /v1/calendar/connections/:provider/authorize
   *
   * Returns the provider's consent URL. A POST rather than a GET because it
   * has a side effect — minting and storing single-use state.
   *
   * Not audited: starting a consent flow connects nothing, and D43 requires
   * `calendar.connected` to record an actual connection rather than an attempt.
   */
  @Post(':provider/authorize')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin connecting the calling user’s own calendar (FR6.1, D40)' })
  async authorize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider', new ParseEnumPipe(CalendarProvider)) provider: CalendarProvider,
  ): Promise<{ authorizationUrl: string }> {
    const adapter = this.registry.get(provider);

    if (!adapter?.isConfigured()) {
      /*
       * 503, because from the caller's side an unconfigured provider and an
       * unreachable one are the same thing: this deployment cannot start the
       * flow. That is distinct from availability, where "not connected" is a
       * reportable state rather than an outage (D42).
       */
      throw new ServiceUnavailableException(
        `${provider} calendar integration is not configured on this deployment`,
      );
    }

    const state = await this.states.issue({ userId: user.id, provider });
    return { authorizationUrl: adapter.authorizationUrl(state) };
  }

  /**
   * POST /v1/calendar/connections/:provider/complete
   *
   * Exchanges the provider's one-time code for a durable grant and stores it
   * encrypted. Audited as `calendar.connected` (D43, C4).
   *
   * NEVER ACCEPTS A TOKEN FROM THE CLIENT. The body carries an authorization
   * code and the state — both single-use and both meaningless without the
   * server's client secret. A refresh token supplied by a caller would let
   * them bind a credential of their choosing to their account, which is why
   * `authorise()` is reachable only from here.
   */
  @Post(':provider/complete')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @Audit({ action: 'calendar.connected', resourceType: 'calendar_connection' })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Complete the OAuth exchange and store the connection (FR6.1)' })
  async complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider', new ParseEnumPipe(CalendarProvider)) provider: CalendarProvider,
    @Body() dto: CompleteConnectionDto,
    @Req() req: RequestContext,
  ): Promise<{ id: string; provider: string; accountIdentifier: string; status: string }> {
    const adapter = this.registry.get(provider);
    if (!adapter?.isConfigured()) {
      throw new ServiceUnavailableException(
        `${provider} calendar integration is not configured on this deployment`,
      );
    }

    /*
     * The provider reports a refusal by sending `error=access_denied` rather
     * than a code. Handled as a clean 400 — the user declining consent is an
     * ordinary outcome, not a fault, and nothing is stored.
     */
    if (dto.error) {
      throw new BadRequestException(`Calendar authorisation was not granted (${dto.error})`);
    }
    if (!dto.code) {
      throw new BadRequestException('code is required when authorisation succeeded');
    }

    // CSRF: single-use, server-held, and destroyed as it is read.
    const claims = await this.states.consume(dto.state);
    if (!claims) {
      throw new UnauthorizedException('This authorisation request is invalid, expired or replayed');
    }

    /*
     * The state was minted for THIS user and THIS provider. Without these two
     * checks a captured code could be completed by a different authenticated
     * user, binding their calendar to someone else's account — the exact
     * cross-account attack the state exists to prevent.
     */
    if (claims.userId !== user.id) {
      throw new ForbiddenException('This authorisation request belongs to another user');
    }
    if (claims.provider !== provider) {
      throw new BadRequestException('This authorisation request was for a different provider');
    }

    let account;
    try {
      account = await adapter.exchangeCode(dto.code);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        throw new ServiceUnavailableException('The calendar provider did not respond');
      }
      if (error instanceof ProviderCredentialError) {
        // A stale, reused or tampered code. The message never echoes the code
        // or anything the provider returned alongside it.
        throw new BadRequestException('The calendar provider rejected this authorisation');
      }
      throw error;
    }

    const connection = await this.connections.authorise({
      userId: user.id,
      provider,
      accountIdentifier: account.accountIdentifier,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });

    // D43 — provider and account identifier only. The credential is already
    // sealed and is not part of this state.
    req.auditState = { before: null, after: toAuditState(connection) };

    return {
      id: connection.id,
      provider: connection.provider,
      accountIdentifier: connection.accountIdentifier,
      status: connection.status,
    };
  }
}
