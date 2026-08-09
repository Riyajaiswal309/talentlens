import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

/**
 * An IANA zone name, e.g. `Europe/London`.
 *
 * Checked for shape only. Validating against the real zone database would
 * need a list this project does not carry, and a wrong-but-well-formed zone
 * is a data error rather than an injection risk — the value is only ever
 * stored and echoed back.
 */
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+)*$/;

/** One window offered to the candidate (Handoff Gap 7 slot shape). */
export class InterviewSlotDto {
  @IsDateString({}, { message: 'startsAt must be an ISO 8601 date-time' })
  startsAt!: string;

  @IsDateString({}, { message: 'endsAt must be an ISO 8601 date-time' })
  endsAt!: string;

  @IsString()
  @Matches(IANA_ZONE, { message: 'timezone must be an IANA zone name, e.g. Europe/London' })
  timezone!: string;
}

/**
 * POST /v1/interviews (PRD §23.2, Phase 1 RC-11).
 *
 * TWO SHAPES, ONE ENDPOINT, because FR6.2 and FR6.3 describe two ways to
 * arrive at the same interview and §23.2 lists only one route:
 *
 *   - SELF-SERVICE (FR6.2) — send `slots`. The candidate receives a link and
 *     picks one; the interview starts in PENDING_SELECTION.
 *   - MANUAL (FR6.3) — send `scheduledAt` and `timezone`. The recruiter
 *     already has the time, so the interview is SCHEDULED immediately and no
 *     link is issued. This is the path Phase 1 flow 8's error row requires
 *     when the provider is down.
 *
 * Exactly one of the two must be present. The service enforces that rather
 * than the DTO: expressing "one or the other but not both" in decorators
 * needs `@ValidateIf`, which disables the whole property's validation when
 * its condition is false — a trap this codebase has already been caught by
 * once, in the score-override reason.
 */
export class CreateInterviewDto {
  @IsUUID('4', { message: 'applicationId must be a valid application id' })
  applicationId!: string;

  /** Self-service path. Gap 7's offered set. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'offer at least one slot' })
  @ArrayMaxSize(20, { message: 'offer at most 20 slots' })
  @ValidateNested({ each: true })
  @Type(() => InterviewSlotDto)
  slots?: InterviewSlotDto[];

  /** Manual path (FR6.3). */
  @IsOptional()
  @IsDateString({}, { message: 'scheduledAt must be an ISO 8601 date-time' })
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  @Matches(IANA_ZONE, { message: 'timezone must be an IANA zone name, e.g. Europe/London' })
  timezone?: string;

  /**
   * The panel (RC-11's interviewer picker).
   *
   * Optional and may be empty: Gap 7 returns `interviewerNames: []` as a
   * legitimate value, and a recruiter can book a slot before the panel is
   * settled.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10, { message: 'at most 10 interviewers' })
  @ArrayUnique({ message: 'interviewerIds contains a duplicate' })
  @IsUUID('4', { each: true, message: 'interviewerIds must all be valid user ids' })
  interviewerIds?: string[];
}
