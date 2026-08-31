import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { AvailabilityController } from './availability.controller';
import { InterviewersController } from './interviewers.controller';
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
 * THE CALENDAR SEAM NOW COMES FROM `CalendarModule`, which binds it to the
 * per-interviewer router and owns both provider adapters (D35). No scheduling
 * logic changed when the real providers arrived, because every caller already
 * asked `isAvailable()` first and tolerated a null event (FR6.3).
 */
@Module({
  imports: [CalendarModule],
  controllers: [
    InterviewsController,
    SchedulingController,
    AvailabilityController,
    InterviewersController,
  ],
  providers: [InterviewsService, SchedulingService, SchedulingTokenService],
  exports: [InterviewsService],
})
export class InterviewsModule {}
