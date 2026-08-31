import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { type InterviewerResponse, ListInterviewersQueryDto } from './dto/interviewer.dto';

const DEFAULT_PAGE_SIZE = 50;

/**
 * Roles that may be put on an interview panel.
 *
 * AN ALLOW-LIST, NOT `{ not: CANDIDATE }`. The two are equivalent today and
 * would stop being equivalent the moment a role is added to the enum: a
 * deny-list silently admits the new role into every interviewer picker in the
 * product, an allow-list silently excludes it until somebody decides. For a
 * route that widens who can read the user table, failing closed is the only
 * safe default.
 *
 * CANDIDATE is excluded for the obvious reason — the subject of an assessment
 * cannot sit on the panel judging it — and `resolvePanel()` in
 * `InterviewsService` independently rejects anything outside the tenant, so
 * this list narrows the picker rather than being the only thing standing
 * between a candidate and an interview seat.
 */
const PANEL_ROLES = [UserRole.ADMIN, UserRole.RECRUITER, UserRole.HIRING_MANAGER];

/**
 * FR6.1 / FR6.3 — who a recruiter may pick as an interviewer.
 *
 * RECRUITER AND ADMIN, matching `POST /v1/interviews` and
 * `GET /v1/interviews/availability` exactly. Hiring Managers are absent for the
 * same reason they are absent from the availability grid (D44): they may be
 * *read* as interviewers and connect their own calendar, but scheduling is not
 * theirs, so they have no need to enumerate colleagues.
 *
 * NOT A REPLACEMENT FOR `GET /v1/admin/users`. That route stays Admin-only and
 * unchanged. This one returns three columns, hides Candidates, and cannot
 * mutate anything — it is the least privilege that makes an interviewer picker
 * possible, rather than a second door onto user administration.
 *
 * NOT AUDITED, consistent with the availability grid beside it: Table I.1 names
 * no read event, and PRD §17.3 records actions that change state.
 */
@ApiTags('interviews')
@Controller('interviewers')
export class InterviewersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @ApiOperation({
    summary: 'List users in the caller’s tenant who may sit on an interview panel (FR6.1)',
    description:
      'Identity and role only — never password hashes, last-active times or calendar state. ' +
      'Candidates are excluded. Scoped to the caller’s company.',
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListInterviewersQueryDto,
  ): Promise<{ data: InterviewerResponse[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const rows = await this.prisma.users.findMany({
      where: {
        // Tenant isolation. `companyId` comes from the verified access token,
        // never from the query string, so there is no parameter to tamper with.
        companyId: user.companyId,
        role: { in: PANEL_ROLES },
      },
      /*
       * SELECTED, NOT FETCHED-THEN-MAPPED. `passwordHash` never leaves the
       * database, so it cannot reach a log, a serialiser or a future edit to
       * the response shape. Mapping a full row would have left the hash one
       * careless spread away from the wire.
       */
      select: { id: true, email: true, role: true },
      /*
       * Alphabetical, because a person picking a colleague scans names rather
       * than signup order. `@@unique([companyId, email])` makes email a total
       * order within a tenant, so no two rows can tie and the cursor cannot
       * skip or repeat a record.
       */
      orderBy: [{ email: 'asc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    return { data, nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null };
  }
}
