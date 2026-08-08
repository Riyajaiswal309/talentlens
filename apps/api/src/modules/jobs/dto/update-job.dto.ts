import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsOptional } from 'class-validator';
import { JobStatus } from '@prisma/client';
import { CreateJobDto } from './create-job.dto';

/**
 * PATCH /v1/jobs/:id — "Edit, publish, or close a job" (Handoff §B row 8).
 *
 * One endpoint covers all three because the PRD models them as one operation.
 * Legal status transitions are enforced in JobsService, not here: the DTO can
 * only say the value is a valid enum member, not whether the move is allowed
 * from the job's current state.
 *
 * Inherits from CreateJobDto, so `aiScoringEnabled` remains absent and
 * BR-04 continues to hold on edit as well as create.
 */
export class UpdateJobDto extends PartialType(CreateJobDto) {
  @IsOptional()
  @IsEnum(JobStatus, { message: 'status must be DRAFT, PUBLISHED or CLOSED' })
  status?: JobStatus;
}
