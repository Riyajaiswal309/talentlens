import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { JobStatus } from '@prisma/client';

/** PRD §23.1 — cursor pagination on every list endpoint. */
export class ListJobsQueryDto {
  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;

  @IsOptional()
  @IsString()
  department?: string;

  /**
   * Opaque to clients: the id of the last row from the previous page.
   *
   * Validated as a UUID so a malformed value is a 400 rather than a 500 —
   * left as a bare string it reaches Postgres and fails the uuid cast.
   */
  @IsOptional()
  @IsUUID('4', { message: 'cursor is not a valid page marker' })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
