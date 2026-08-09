import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { CreateInterviewDto } from './dto/create-interview.dto';
import { InterviewsService, type InterviewView } from './interviews.service';

/** What RC-11 and CA-05 render for one interview. */
interface InterviewResponse {
  id: string;
  applicationId: string;
  jobId: string;
  jobTitle: string;
  status: string;
  scheduledAt: string | null;
  timezone: string | null;
  /** Null whenever the interview was arranged without a provider (FR6.3). */
  calendarEventId: string | null;
  interviewers: { id: string; email: string }[];
  slots: { slotId: string; startsAt: string; endsAt: string; timezone: string }[];
  selectedSlotId: string | null;
  createdAt: string;
}

function toResponse(interview: InterviewView): InterviewResponse {
  return {
    id: interview.id,
    applicationId: interview.applicationId,
    jobId: interview.application.job.id,
    jobTitle: interview.application.job.title,
    status: interview.status,
    scheduledAt: interview.scheduledAt?.toISOString() ?? null,
    timezone: interview.timezone,
    calendarEventId: interview.calendarEventId,
    interviewers: interview.interviewers.map((i) => ({ id: i.user.id, email: i.user.email })),
    slots: interview.slots.map((slot) => ({
      slotId: slot.id,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      timezone: slot.timezone,
    })),
    selectedSlotId: interview.selectedSlotId,
    createdAt: interview.createdAt.toISOString(),
  };
}

/**
 * FR6.1–FR6.3 — the hiring team's side of interview scheduling.
 *
 * Recruiter and Administrator only, per PRD §23.2 ("`POST /v1/interviews` —
 * Recruiter, Admin") and Phase 1 RC-11's role column. Hiring Managers are
 * absent from both and so are absent here; they can still read an interview
 * on a job they are assigned to, which is what RC-06 shows them.
 *
 * NEITHER ROUTE IS AUDITED, and that is a decision rather than an omission.
 * Handoff §I Table I.1 fixes the Phase 2 audit vocabulary and contains no
 * interview event. The same reasoning already applies to scorecards and
 * comments: extending a list the Handoff sets deliberately would make the
 * audit browser's "unknown action → 400" rule (Gap 4 rule 2) meaningless.
 * If interviews should be audited, Table I.1 is where that is decided.
 */
@Controller()
export class InterviewsController {
  constructor(private readonly interviews: InterviewsService) {}

  /**
   * POST /v1/interviews (PRD §23.2, Phase 1 RC-11, flow 8).
   *
   * Returns the scheduling token alongside the interview on the self-service
   * path. RC-11's "link generator" needs it: the recruiter is shown the link
   * they just sent, so they can copy it if the candidate says the email never
   * arrived. It is omitted entirely on the manual path, where none exists.
   */
  @Post('interviews')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInterviewDto,
  ): Promise<InterviewResponse & { schedulingToken?: string; expiresAt?: string }> {
    const { interview, schedulingToken, expiresAt } = await this.interviews.create(user, dto);

    return {
      ...toResponse(interview),
      ...(schedulingToken ? { schedulingToken, expiresAt: expiresAt?.toISOString() } : {}),
    };
  }

  /**
   * GET /v1/applications/:id/interviews.
   *
   * Not in PRD §23.2 — it belongs on the amendment list. Phase 1 flow 8's
   * success criterion is "Interview appears on RC-11 and CA-05" and line 1240
   * binds `interviews` to both, neither of which is reachable without a read
   * path. Same shape and same scoping as the documented siblings
   * `…/scorecards` and `…/comments`.
   *
   * Hiring Managers are included, unlike on the write route: RC-06 is a
   * Hiring Manager screen and it carries "Schedule interview" as a visible
   * secondary action, so withholding the existing interviews from them would
   * show an empty panel on a screen the design says has content.
   */
  @Get('applications/:id/interviews')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: InterviewResponse[] }> {
    const interviews = await this.interviews.listForApplication(user, id);
    return { data: interviews.map(toResponse) };
  }
}
