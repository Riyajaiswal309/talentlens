import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ConfirmSlotDto } from './dto/confirm-slot.dto';
import {
  SchedulingService,
  type SchedulingConfirmation,
  type SchedulingOffer,
} from './scheduling.service';

/**
 * FR6.2 — the candidate's self-service scheduling link (Handoff Gap 7, CA-06).
 *
 * `@Public()` because the scheduling token IS the credential: Gap 7 states
 * "the scheduling token itself — no session required", and PRD §24.2 grants
 * the Candidate role no session-based access to interview resources. The
 * mechanism is Handoff decision D5, "signed, single-purpose, expiring token".
 *
 * Public does not mean unauthenticated in effect. `SchedulingTokenService`
 * verifies an HMAC over the payload before either route touches the database,
 * and a token names exactly one interview (Gap 7 rule 4) — there is no
 * parameter here that can widen what it reaches.
 *
 * NOT AUDITED, for the same reason as the recruiter side: Handoff §I Table
 * I.1 has no interview event. Note that the audit machinery would work if one
 * were added — `auditCompanyId` exists precisely so a public route can record
 * a tenant — so this is a vocabulary decision, not a technical limit.
 */
@Controller('scheduling')
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  /**
   * GET /v1/scheduling/:token — the slots on offer (Gap 7).
   *
   * The token is a path segment rather than a validated UUID param, so no
   * `ParseUUIDPipe`: it is an opaque signed string, and a malformed one is a
   * `401` from the verifier, not a `400` from a pipe.
   */
  @Get(':token')
  @Public()
  async offer(@Param('token') token: string): Promise<SchedulingOffer> {
    return this.scheduling.getOffer(token);
  }

  /** POST /v1/scheduling/:token/confirm — take a slot (Gap 7). */
  @Post(':token/confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Param('token') token: string,
    @Body() dto: ConfirmSlotDto,
  ): Promise<SchedulingConfirmation> {
    return this.scheduling.confirm(token, dto.slotId);
  }
}
