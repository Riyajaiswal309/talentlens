import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * PATCH /v1/applications/:id/stage (PRD §23.2, Handoff §B row 15).
 *
 * The target is a stage NAME, not an id. `applications.current_stage` and
 * `stage_history.to_stage` both store the name (PRD §17.2), because stages
 * are per-job configurable data rather than a global enumeration (decision
 * B2). Accepting an id here would mean the two columns disagreed with the
 * request that set them.
 */
export class ChangeStageDto {
  @IsString()
  @MinLength(1, { message: 'toStage is required' })
  @MaxLength(100)
  toStage!: string;
}
