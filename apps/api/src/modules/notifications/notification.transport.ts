import { Injectable, Logger } from '@nestjs/common';

export interface Notification {
  to: string;
  subject: string;
  body: string;
}

/**
 * Where a notification goes (FR2.3).
 *
 * An abstract class so it survives to runtime as its own injection token —
 * the same pattern as ResumeScanner and AiScoringPort. Swapping the console
 * for SES or SMTP is a one-line provider change in NotificationsModule.
 */
@Injectable()
export abstract class NotificationTransport {
  abstract send(notification: Notification): Promise<void>;
}

/**
 * The Phase 2 transport, per Handoff module table row 9: "NotificationsModule
 * — FR2.3 — Full, console transport in P2 [PROP]".
 *
 * Deliberately not email. No provider, domain or sender identity is specified
 * anywhere in the PRD, and sending real mail from a student project to
 * addresses typed into a public form would be the wrong default. The console
 * makes the notification observable and testable; the boundary above makes
 * replacing it trivial.
 */
@Injectable()
export class ConsoleNotificationTransport extends NotificationTransport {
  private readonly logger = new Logger('Notification');

  send(notification: Notification): Promise<void> {
    this.logger.log(`to=${notification.to} subject="${notification.subject}"`);
    this.logger.debug(notification.body);
    return Promise.resolve();
  }
}
