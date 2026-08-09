import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Approved batch ceiling — matches the pagination bound used elsewhere. */
export const MAX_BULK_APPLICATIONS = 100;

/**
 * PATCH /v1/applications/bulk/stage (Handoff §B row 16, FR5.2).
 *
 * One target stage for the whole batch. FR5.2 names "bulk actions (stage
 * change, rejection, tagging)"; rejection is this endpoint with a terminal
 * stage, and tagging has no storage in the schema, so it is not offered here.
 */
export class BulkChangeStageDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Select at least one candidate' })
  @ArrayMaxSize(MAX_BULK_APPLICATIONS, {
    message: `A bulk action may cover at most ${MAX_BULK_APPLICATIONS} candidates`,
  })
  @IsUUID('4', { each: true, message: 'applicationIds must all be valid identifiers' })
  applicationIds!: string[];

  @IsString()
  @MinLength(1, { message: 'toStage is required' })
  @MaxLength(100)
  toStage!: string;
}
