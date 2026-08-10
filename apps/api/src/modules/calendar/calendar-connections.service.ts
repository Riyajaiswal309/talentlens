import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type CalendarConnection,
  CalendarConnectionStatus,
  type CalendarProvider,
  type Prisma,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { CalendarCredentialCipher } from './calendar-credential.cipher';

/**
 * The only projection of a connection that may enter an audit record (D43).
 *
 * Provider and account identifier, and nothing else — no token, ciphertext,
 * key, authorization code or OAuth state. Typed as `Prisma.InputJsonValue`
 * because that is what the audit columns accept, matching `toStageAuditState`.
 *
 * ONE FUNCTION, so "what may leave the boundary" is decided in a single place
 * rather than at each call site.
 */
export function toAuditState(connection: CalendarConnection): Prisma.InputJsonValue {
  return {
    provider: connection.provider,
    accountIdentifier: connection.accountIdentifier,
  };
}

/**
 * Calendar connection lifecycle (FR6.1 Phase 1, amendments D34–D45).
 *
 * STORAGE AND LIFECYCLE ONLY. No Google or Microsoft call is made from here;
 * `authorise` is invoked by a provider adapter once a real OAuth exchange has
 * produced a refresh token, and no such adapter exists yet. Nothing in this
 * file accepts a credential from an HTTP client.
 */
@Injectable()
export class CalendarConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CalendarCredentialCipher,
  ) {}

  /**
   * Record an authorised connection, replacing any previous one (D34, D37).
   *
   * NOT REACHABLE FROM AN ENDPOINT. The refresh token argument may only ever
   * come from a provider adapter that performed the OAuth exchange itself —
   * accepting one over HTTP would let a caller plant a credential of their
   * choosing, which is why no controller calls this.
   *
   * Re-authorising the same provider replaces the stored credential rather
   * than adding a row (the `(user_id, provider)` unique constraint), so the
   * adapter is never ambiguous about which token to use, and a re-connect
   * after a disconnect returns the row to `connected`.
   */
  async authorise(input: {
    userId: string;
    provider: CalendarProvider;
    accountIdentifier: string;
    refreshToken: string;
    expiresAt?: Date | null;
  }): Promise<CalendarConnection> {
    const encryptedRefreshToken = this.cipher.seal(input.refreshToken);

    return this.prisma.calendarConnection.upsert({
      where: { userId_provider: { userId: input.userId, provider: input.provider } },
      create: {
        userId: input.userId,
        provider: input.provider,
        accountIdentifier: input.accountIdentifier,
        encryptedRefreshToken,
        expiresAt: input.expiresAt ?? null,
        status: CalendarConnectionStatus.connected,
      },
      update: {
        accountIdentifier: input.accountIdentifier,
        encryptedRefreshToken,
        expiresAt: input.expiresAt ?? null,
        status: CalendarConnectionStatus.connected,
        // Re-connecting clears the previous disconnection.
        disconnectedAt: null,
      },
    });
  }

  /** Every connection this user personally authorised. */
  listOwn(user: AuthenticatedUser): Promise<CalendarConnection[]> {
    return this.prisma.calendarConnection.findMany({
      where: { userId: user.id },
      orderBy: [{ provider: 'asc' }],
    });
  }

  /**
   * Disconnect one's own calendar (D44).
   *
   * A CANDIDATE CANNOT REACH THIS. §24.2 grants them nothing here and they are
   * never interviewers; the controller's @Roles excludes them and this repeats
   * the check, because the service is also called from the FR8.4 path where no
   * route decorator applies.
   */
  async disconnectOwn(user: AuthenticatedUser, provider: CalendarProvider) {
    if (user.role === UserRole.CANDIDATE) {
      throw new ForbiddenException('Candidates do not connect calendars');
    }

    const connection = await this.prisma.calendarConnection.findFirst({
      where: { userId: user.id, provider },
    });

    if (!connection) throw new NotFoundException();

    return this.markDisconnected(connection.id);
  }

  /**
   * An Administrator disconnects another user's calendar (D44).
   *
   * TENANCY IS REACHED THROUGH THE OWNER. `calendar_connections` has no
   * company_id of its own — deliberately, so it cannot drift from the owning
   * user — which is why the scope is expressed as `user.companyId` here.
   *
   * Refusal is 404, never 403: a 403 would confirm that a user id exists in
   * another tenant (BR-06, PRD §26). That applies to the target user as much
   * as to the connection.
   */
  async disconnectForUser(admin: AuthenticatedUser, userId: string, provider: CalendarProvider) {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider, user: { companyId: admin.companyId } },
    });

    if (!connection) throw new NotFoundException();

    return this.markDisconnected(connection.id);
  }

  /**
   * FR8.4 / D45 — drop every connection a user holds.
   *
   * Called when an administrator revokes the user's sessions. Returns the
   * connections that were actually live, so the caller can audit one
   * `calendar.disconnected` per connection and none when there was nothing to
   * disconnect.
   *
   * LOCAL INVALIDATION ONLY in this phase. The stored credential is cleared so
   * this system can no longer use it; telling Google or Microsoft to revoke
   * their side needs a provider adapter that does not exist yet.
   */
  async disconnectAllForUser(userId: string): Promise<CalendarConnection[]> {
    const live = await this.prisma.calendarConnection.findMany({
      where: { userId, status: CalendarConnectionStatus.connected },
    });

    for (const connection of live) {
      await this.markDisconnected(connection.id);
    }

    return live;
  }

  /**
   * Resolve a usable credential — the ONLY place a plaintext token appears.
   *
   * Reserved for the provider adapter. Returns null when the connection is
   * absent, already disconnected, or holds a credential that will not open —
   * and in that last case moves the connection to `disconnected` rather than
   * leaving the adapter to retry a value that can never work (D36).
   */
  async resolveRefreshToken(userId: string, provider: CalendarProvider): Promise<string | null> {
    const connection = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider, status: CalendarConnectionStatus.connected },
    });

    if (!connection?.encryptedRefreshToken) return null;

    const token = this.cipher.open(connection.encryptedRefreshToken);
    if (!token) {
      await this.markDisconnected(connection.id);
      return null;
    }

    return token;
  }

  /**
   * Move a connection to `disconnected` and clear its credential.
   *
   * The row is kept rather than deleted so "was connected and stopped working"
   * stays distinguishable from "never connected"; the secret is not, because
   * a disconnected connection has no use for it.
   */
  private markDisconnected(id: string): Promise<CalendarConnection> {
    return this.prisma.calendarConnection.update({
      where: { id },
      data: {
        status: CalendarConnectionStatus.disconnected,
        encryptedRefreshToken: null,
        disconnectedAt: new Date(),
      },
    });
  }
}
