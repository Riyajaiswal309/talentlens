import { Global, Module } from '@nestjs/common';
import { ConsoleNotificationTransport, NotificationTransport } from './notification.transport';
import { NotificationsService } from './notifications.service';

/**
 * PRD §15.3 `NotificationsModule` — FR2.3.
 *
 * NO MILESTONE EVER OWNED THIS. It appears in the Handoff module table (row
 * 9, "Full — console transport in P2") but in none of M2.1–M2.10, so it was
 * never built. Added in the remaining-gaps pass at the size the Handoff
 * describes and no larger.
 *
 * Global because both intake (ApplicationsModule) and stage movement
 * (PipelineModule) notify, and threading an import through both to reach a
 * single logger-backed service would be ceremony without benefit.
 */
@Global()
@Module({
  providers: [
    { provide: NotificationTransport, useClass: ConsoleNotificationTransport },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
