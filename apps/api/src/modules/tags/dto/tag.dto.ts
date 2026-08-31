import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** FR5.2 — long enough for "Strong Python + AWS", short enough to stay a tag. */
export const MAX_TAG_LENGTH = 40;

/**
 * Add a tag to an application (FR5.2).
 *
 * NORMALISED BEFORE VALIDATION, not after: the value is trimmed and its
 * internal whitespace collapsed, so " senior   backend " and "senior backend"
 * are the same tag rather than two that merely look alike. The label is stored
 * as the recruiter cased it — the database's case-insensitive unique index is
 * what stops "Python" and "python" both existing.
 */
export class AddTagDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  @IsString({ message: 'A tag label is required' })
  @MinLength(1, { message: 'A tag cannot be empty' })
  @MaxLength(MAX_TAG_LENGTH, {
    message: `A tag must be ${MAX_TAG_LENGTH} characters or fewer`,
  })
  /*
   * Control characters are rejected outright. A tag is rendered as a chip in a
   * list; a newline or a tab would break that layout and carries no meaning in
   * a label.
   */
  @Matches(/^[^\p{Cc}]+$/u, { message: 'A tag cannot contain control characters' })
  label!: string;
}

/** One tag as the API returns it. No internal user id — the email, as elsewhere. */
export interface TagResponse {
  id: string;
  label: string;
  createdAt: string;
  createdByEmail: string;
}

/** Mirrors `MAX_BULK_APPLICATIONS` on the stage-change path — one bulk ceiling. */
export const MAX_BULK_TAG_APPLICATIONS = 100;

/**
 * Apply one tag to several applications (FR5.2 — "bulk actions are supported
 * (stage change, rejection, tagging) across multiple candidates").
 *
 * Extends `AddTagDto` so the label rules cannot drift between the single and
 * bulk paths: same trim, same length, same control-character refusal.
 */
export class BulkAddTagDto extends AddTagDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Select at least one candidate' })
  @ArrayMaxSize(MAX_BULK_TAG_APPLICATIONS, {
    message: `A bulk action may cover at most ${MAX_BULK_TAG_APPLICATIONS} candidates`,
  })
  @IsUUID('4', { each: true, message: 'applicationIds must all be valid identifiers' })
  applicationIds!: string[];
}

/**
 * What a bulk tag did, per application.
 *
 * THREE BUCKETS, NOT TWO. `alreadyTagged` is separated from `tagged` because
 * they are different facts: one is a change, the other is a no-op. Collapsing
 * them would make the audit trail claim writes that never happened, and would
 * tell the recruiter twelve candidates were tagged when two already were.
 *
 * `failed` carries a reason per id and is never silent — an inaccessible or
 * cross-tenant application is reported, not skipped. The reason is identical
 * for "does not exist" and "belongs to another tenant", per BR-06.
 */
export interface BulkTagResponse {
  label: string;
  tagged: string[];
  alreadyTagged: string[];
  failed: { id: string; reason: string }[];
}
