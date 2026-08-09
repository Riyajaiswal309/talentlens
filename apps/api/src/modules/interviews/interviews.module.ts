import { Module } from '@nestjs/common';
import { CalendarProvider, ManualCalendarProvider } from './calendar.provider';
import { InterviewsController } from './interviews.controller';
import { InterviewsService } from './interviews.service';
import { SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';
import { SchedulingTokenService } from './scheduling-token.service';

/**
 * FR6.1–FR6.3 — interview scheduling (PRD §15.3 `InterviewsModule`).
 *
 * Deferred out of Phase 2 by Handoff decision D3 and built here, in Phase 2b.
 *
 * Both halves of the requirement live together: the recruiter books
 * (InterviewsController) and the candidate chooses (SchedulingController).
 * They are one module because they share the token contract and the slot
 * table — splitting them would put the issuing of a credential in a different
 * module from its verification, which is exactly where those two drift apart.
 *
 * THE CALENDAR BINDING HAPPENS IN ONE PLACE, here, matching how
 * `ResumeScanner` and `AiScoringPort` are bound. FR6.1's Google and Outlook
 * integrations replace this single line; no scheduling logic changes with
 * them, because every caller already asks `isAvailable()` first and tolerates
 * a null event (FR6.3).
 */
@Module({
  controllers: [InterviewsController, SchedulingController],
  providers: [
    InterviewsService,
    SchedulingService,
    SchedulingTokenService,
    { provide: CalendarProvider, useClass: ManualCalendarProvider },
  ],
  exports: [InterviewsService],
})
export class InterviewsModule {}
