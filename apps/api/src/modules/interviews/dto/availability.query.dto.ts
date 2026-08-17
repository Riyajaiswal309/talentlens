import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsDateString, IsUUID } from 'class-validator';

/**
 * Query for `GET /v1/interviews/availability` (FR6.1, amendment D42).
 *
 * IDENTITY IS `user_id`, NOT EMAIL (D42, D39). `users.email` is unique per
 * tenant only, so an email is not a safe key, and D37 makes the provider
 * account identifier a separate thing altogether — it appears in the response,
 * never in the request.
 *
 * NO CURSOR (D42). §23.1's "cursor-based on all list endpoints" addresses
 * unbounded collections; a free/busy query is bounded by its own window, and a
 * cursor over a grid would be meaningless.
 */
export class AvailabilityQueryDto {
  /**
   * The interviewers to look up.
   *
   * Express gives a single `?interviewerIds=` a string and repeats an array,
   * so both shapes are normalised here before validation sees them.
   */
  @Transform(({ value }) =>
    value === undefined ? undefined : Array.isArray(value) ? value : String(value).split(','),
  )
  @ArrayMinSize(1, { message: 'interviewerIds must name at least one interviewer' })
  @ArrayMaxSize(20, { message: 'interviewerIds must name at most 20 interviewers' })
  @ArrayUnique({ message: 'interviewerIds contains a duplicate' })
  @IsUUID('4', { each: true, message: 'interviewerIds must all be valid user ids' })
  interviewerIds!: string[];

  /** Inclusive start of the window. */
  @IsDateString({}, { message: 'from must be an ISO 8601 date-time' })
  from!: string;

  /** Inclusive end of the window. */
  @IsDateString({}, { message: 'to must be an ISO 8601 date-time' })
  to!: string;
}
