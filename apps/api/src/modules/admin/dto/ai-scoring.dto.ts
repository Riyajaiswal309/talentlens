import { IsBoolean } from 'class-validator';

/**
 * PATCH /v1/admin/jobs/:id/ai-scoring (PRD §23.2, FR8.2, BR-04).
 *
 * The one route permitted to write `jobs.ai_scoring_enabled`. Every recruiter
 * DTO omits the field entirely so `forbidNonWhitelisted` rejects it, which is
 * what makes BR-04 structural rather than a check someone could forget.
 */
export class SetAiScoringDto {
  @IsBoolean({ message: 'enabled must be true or false' })
  enabled!: boolean;
}
