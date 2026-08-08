import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * FR1.2 — "Job postings capture structured fields: title, department,
 * location, employment type, required skills, experience level, description."
 *
 * NOTE WHAT IS ABSENT: `aiScoringEnabled`.
 *
 * FR1.4 and BR-04 reserve that flag to Administrators, who set it through
 * PATCH /v1/admin/jobs/:id/ai-scoring. Because the global ValidationPipe runs
 * with `forbidNonWhitelisted: true`, a recruiter who submits the field gets a
 * 400 rather than silently having it ignored. Omission here IS the
 * enforcement — there is no code path to strip it later.
 *
 * `status` is absent for the same reason: a job is always created as DRAFT
 * and moves via PATCH, so publication cannot be smuggled in at creation.
 */
export class CreateJobDto {
  @IsString()
  @MinLength(1, { message: 'Title is required' })
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  employmentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  experienceLevel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  /** Stored as jsonb so the PRD §17.4 GIN index applies. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  @Type(() => String)
  requiredSkills?: string[];
}
