import { Module } from '@nestjs/common';
import { CalendarProvider } from '../interviews/calendar.provider';
import { CalendarConnectionsController } from './calendar-connections.controller';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarCredentialCipher } from './calendar-credential.cipher';
import { CalendarOAuthController } from './calendar-oauth.controller';
import { CalendarProviderRegistry } from './calendar-provider.registry';
import { ConnectedCalendarProvider } from './connected-calendar.provider';
import { OAuthStateStore } from './oauth-state.store';
import { GoogleCalendarAdapter } from './providers/google-calendar.adapter';
import { MicrosoftCalendarAdapter } from './providers/microsoft-calendar.adapter';

/**
 * FR6.1 — calendar integration (D34–D45).
 *
 * THE ONLY PLACE THAT KNOWS GOOGLE AND MICROSOFT EXIST. Both adapters are
 * registered here and reached through `CalendarProviderRegistry`; everything
 * above — scheduling, availability, the audit trail — deals in the
 * `CalendarProvider` seam and the `provider` enum, which is what D35 requires.
 *
 * `CalendarProvider` is bound to `ConnectedCalendarProvider`, replacing the
 * manual stub. That binding is deliberately still safe on a deployment with no
 * client credentials: the router reports available, creates no event and
 * returns null availability, which is exactly `ManualCalendarProvider`'s
 * behaviour and keeps FR6.3 intact.
 *
 * Exported rather than @Global(): AdminModule imports this for the FR8.4
 * revocation D45 requires, and InterviewsModule for the seam.
 */
@Module({
  controllers: [CalendarConnectionsController, CalendarOAuthController],
  providers: [
    CalendarConnectionsService,
    CalendarCredentialCipher,
    CalendarProviderRegistry,
    OAuthStateStore,
    GoogleCalendarAdapter,
    MicrosoftCalendarAdapter,
    { provide: CalendarProvider, useClass: ConnectedCalendarProvider },
  ],
  exports: [
    CalendarConnectionsService,
    CalendarCredentialCipher,
    CalendarProviderRegistry,
    OAuthStateStore,
    CalendarProvider,
  ],
})
export class CalendarModule {}
