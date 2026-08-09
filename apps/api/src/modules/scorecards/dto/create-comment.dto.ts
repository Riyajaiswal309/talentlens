import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * POST /v1/applications/:id/comments — FR5.3.
 *
 * NOT IN PRD §23.2. FR5.3 requires comments to be visible to the hiring team
 * but no endpoint was ever specified, so the path mirrors the documented
 * sibling `POST /v1/applications/:id/scorecards` exactly. Recorded as an
 * amendment.
 */
export class CreateCommentDto {
  @IsString({ message: 'A comment body is required' })
  // \S rather than MinLength(1): whitespace is not a comment.
  @Matches(/\S/, { message: 'A comment body is required' })
  @MaxLength(5000, { message: 'A comment must be 5000 characters or fewer' })
  body!: string;
}
