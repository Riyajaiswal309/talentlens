import {
  BadRequestException,
  Controller,
  Get,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { ProviderUnavailableError } from '../calendar/providers/provider-adapter';
import { CalendarProvider } from './calendar.provider';
import { AvailabilityQueryDto } from './dto/availability.query.dto';

/** The D42 response. */
interface AvailabilityResponse {
  from: string;
  to: string;
  availability: {
    email: string;
    busy: { startsAt: string; endsAt: string }[];
  }[];
  /**
   * Interviewers with no usable calendar, by `user_id`.
   *
   * A REPORTABLE STATE, NOT A FAILURE (D42). Returning 404 or 503 because
   * somebody has not linked an account would tell a recruiter the system is
   * broken when the truth is that RC-11 should prompt that person to connect.
   */
  notConnected: string[];
}

/**
 * FR6.1 — interviewer availability (amendment D42, B8).
 *
 * The endpoint §23.2 never specified and Phase 1's Table 12.3 omitted despite
 * RC-11 rendering an availability grid (E3).
 *
 * Recruiter and Admin, matching RC-11 and `POST /v1/interviews`. Hiring
 * Managers are absent: they may connect their own calendar (D44) and be read
 * as interviewers, but scheduling is not theirs.
 *
 * NOT AUDITED. Handoff §I Table I.1 names no availability event, and PRD §17.3
 * records actions that change state; reading a grid is not one.
 */
@Controller('interviews')
export class AvailabilityController {
  constructor(
    private readonly calendar: CalendarProvider,
    private readonly prisma: PrismaService,
  ) {}

  @Get('availability')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Interviewer free/busy for a bounded window (FR6.1)',
    description:
      'Busy intervals only — never event titles, attendees, locations or descriptions. ' +
      'Interviewers with no connected calendar are listed in notConnected.',
  })
  async availability(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponse> {
    const from = new Date(query.from);
    const to = new Date(query.to);

    if (from >= to) {
      throw new BadRequestException('from must be before to');
    }

    /*
     * TENANT SCOPE. Only users of the caller's own company are looked up, so
     * an id from another tenant simply is not found — and it then appears in
     * `notConnected` exactly as an unlinked colleague would.
     *
     * That is deliberate: it is the 404-not-403 principle (BR-06) applied to a
     * bulk read. Refusing the whole request with a 404 would confirm that a
     * particular user id exists somewhere, and a 403 would be worse. The
     * caller learns nothing about ids outside their tenant beyond "no calendar
     * data", which is what they would learn about an unlinked colleague.
     */
    const tenantUsers = await this.prisma.users.findMany({
      where: { id: { in: query.interviewerIds }, companyId: user.companyId },
      select: { id: true },
    });
    const visibleIds = tenantUsers.map((u) => u.id);

    let availability;
    try {
      availability = await this.calendar.getAvailability(visibleIds, { from, to });
    } catch (error) {
      /*
       * Gap 7's 503, and only for this: a CONFIGURED provider that did not
       * answer. Raised through the standard ProblemDetails path (§23.1).
       */
      if (error instanceof ProviderUnavailableError) {
        throw new ServiceUnavailableException(
          'The calendar provider is unavailable. Availability cannot be read; ' +
            'schedule manually and try again later.',
        );
      }
      throw error;
    }

    /*
     * Null means no provider is configured at all — manual-scheduling mode
     * (FR6.3). Everyone asked about is unconnected, which is true, and it is
     * still a 200: the recruiter's next step is to enter a time by hand, not
     * to treat the system as down.
     */
    const entries = availability ?? [];
    const answeredAccounts = new Set(entries.map((entry) => entry.email));

    /*
     * `notConnected` is by `user_id`, because that is what the caller asked
     * with. It covers three cases that are all the same to a recruiter: no
     * connection, a disconnected one, and an id outside the tenant.
     */
    const connected = await this.prisma.calendarConnection.findMany({
      where: { userId: { in: visibleIds }, accountIdentifier: { in: [...answeredAccounts] } },
      select: { userId: true },
    });
    const answeredUserIds = new Set(connected.map((c) => c.userId));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      availability: entries.map((entry) => ({
        email: entry.email,
        busy: entry.busy.map((block) => ({
          startsAt: block.startsAt.toISOString(),
          endsAt: block.endsAt.toISOString(),
        })),
      })),
      notConnected: query.interviewerIds.filter((id) => !answeredUserIds.has(id)),
    };
  }
}
