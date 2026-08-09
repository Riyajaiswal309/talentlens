import { Injectable, Logger } from '@nestjs/common';
import { NotificationTransport } from './notification.transport';

/**
 * FR2.3 — "Candidates receive confirmation and status-change notifications
 * by email."
 *
 * Exactly two notifications, because exactly two are named: confirmation on
 * submission (Phase 1 CA-04 "Confirmation email dispatched", flow 3 step 9)
 * and a status change (§9.2 step 7, "Receives a final outcome notification").
 * Nothing else is invented.
 *
 * NEVER FAILS THE CALLER. FR2.5 makes intake independent of everything
 * downstream, and a stage move is a recruiter action that must not be undone
 * because a message could not be delivered. Failures are logged; the caller
 * proceeds.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly transport: NotificationTransport) {}

  /** FR2.3 / CA-04 — sent once the application exists. */
  async applicationReceived(input: {
    email: string;
    candidateName: string;
    jobTitle: string;
    reference: string;
  }): Promise<void> {
    await this.deliver({
      to: input.email,
      subject: `We received your application for ${input.jobTitle}`,
      body:
        `Hello ${input.candidateName},\n\n` +
        `Thank you for applying for ${input.jobTitle}. Your reference is ${input.reference}.\n\n` +
        `You can quote this reference in any correspondence about your application.`,
    });
  }

  /**
   * FR2.3 — a stage change.
   *
   * The candidate is told their status moved, not the internal stage name of
   * every step: §9.2 describes an outcome notification, and a candidate does
   * not need to know they are in "Screening" versus "Interview" the moment a
   * recruiter drags a card.
   */
  async applicationStatusChanged(input: {
    email: string;
    candidateName: string;
    jobTitle: string;
    toStage: string;
    isTerminal: boolean;
  }): Promise<void> {
    const subject = input.isTerminal
      ? `An update on your application for ${input.jobTitle}`
      : `Your application for ${input.jobTitle} has progressed`;

    await this.deliver({
      to: input.email,
      subject,
      body:
        `Hello ${input.candidateName},\n\n` +
        `Your application for ${input.jobTitle} is now at the "${input.toStage}" stage.`,
    });
  }

  /**
   * FR6.2 — "Candidates receive a self-service scheduling link."
   *
   * The third notification, and named as explicitly as the other two: Phase 1
   * flow 8 step 3 is "send self-service scheduling link to candidate (FR6.2)".
   *
   * The token is delivered as a path, not an absolute URL. No document names
   * a candidate-facing hostname, and inventing one would put a wrong link in
   * a real inbox; the transport that eventually sends mail is where a base URL
   * belongs.
   */
  async interviewSchedulingLink(input: {
    email: string;
    candidateName: string;
    jobTitle: string;
    token: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.deliver({
      to: input.email,
      subject: `Choose your interview time for ${input.jobTitle}`,
      body:
        `Hello ${input.candidateName},\n\n` +
        `You have been invited to interview for ${input.jobTitle}. ` +
        `Choose a time that suits you here:\n\n` +
        `  /scheduling/${input.token}\n\n` +
        `This link is for this interview only and expires on ` +
        `${input.expiresAt.toISOString()}.`,
    });
  }

  private async deliver(notification: {
    to: string;
    subject: string;
    body: string;
  }): Promise<void> {
    try {
      await this.transport.send(notification);
    } catch (error) {
      this.logger.error(
        `notification not delivered to ${notification.to}: ${notification.subject}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
