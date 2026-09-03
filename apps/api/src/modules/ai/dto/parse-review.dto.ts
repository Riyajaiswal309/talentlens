import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** FR3.2 / PRD §20 stage 5 — below this a field is flagged, not accepted. */
export const CONFIDENCE_THRESHOLD = 0.75;

/**
 * Field paths a caller may correct (Gap 3 rule 1).
 *
 * A closed set: "fieldPath must resolve to a known field in the
 * parsed_profiles schema — arbitrary keys rejected". Indexed paths are
 * matched by prefix, e.g. `work_history[0].employer`.
 */
export const PARSED_PROFILE_FIELD_ROOTS = [
  'contact',
  'skills',
  'work_history',
  'education',
  'certifications',
] as const;

/**
 * `contact` IS EDITABLE, and leaving it out was a defect rather than a policy.
 *
 * The rule-based parser scores exactly five things — `contact.email`,
 * `contact.phone`, `contact.name`, `contact.location` and `skills` — and it
 * caps `contact.name` at 0.7 and an unprefixed `contact.phone` at 0.6, both
 * BELOW the 0.75 flag threshold. So the review queue is largely `contact.*`,
 * and with `contact` outside this grammar every flagged field answered
 * `400 Unknown field path`: the queue could be read but never actioned.
 *
 * The earlier tests missed it because their fixtures seeded `field_confidence`
 * with `skills[0]` and `education[0].degree` by hand rather than with anything
 * the parser actually emits.
 */
const FIELD_PATH = /^(contact|skills|work_history|education|certifications)(\[\d+\])?(\.[a-z_]+)*$/;

export function isKnownFieldPath(path: string): boolean {
  return FIELD_PATH.test(path);
}

/** GET /v1/jobs/:id/parse-review — Gap 3. */
export class ParseReviewQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'limit must be between 1 and 100' })
  @Max(100, { message: 'limit must be between 1 and 100' })
  limit?: number;
}

/** One corrected field. Gap 3: `{ value, confirmed: true }`. */
export class FieldCorrection {
  @IsDefined({ message: 'value is required' })
  value!: unknown;

  @IsBoolean()
  confirmed!: boolean;
}

/** PATCH /v1/parsed-profiles/:id — Gap 3. */
export class PatchParsedProfileDto {
  @IsObject({ message: 'fields must be an object of field paths' })
  fields!: Record<string, FieldCorrection>;
}
