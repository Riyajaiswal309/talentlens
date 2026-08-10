import { Module } from '@nestjs/common';
import { CalendarConnectionsController } from './calendar-connections.controller';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarCredentialCipher } from './calendar-credential.cipher';

/**
 * FR6.1 Phase 1 — the calendar connection foundation (D34–D45).
 *
 * STORAGE, LIFECYCLE AND THE CREDENTIAL BOUNDARY ONLY. No Google or Microsoft
 * SDK, no OAuth route, no availability, no event synchronisation. The provider
 * adapters that D35 requires will bind against `CalendarConnectionsService`
 * and `CalendarCredentialCipher`; neither needs to change when they arrive.
 *
 * Exported rather than @Global(): AdminModule is the only other module that
 * needs the service — FR8.4 revocation must drop a user's connections (D45) —
 * so it imports this module explicitly. An ambient global would have hidden a
 * real dependency and left every test harness mounting AdminModule to
 * discover it through a DI failure.
 */
@Module({
  controllers: [CalendarConnectionsController],
  providers: [CalendarConnectionsService, CalendarCredentialCipher],
  exports: [CalendarConnectionsService, CalendarCredentialCipher],
})
export class CalendarModule {}
