import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JobScoped } from '../../common/decorators/resource-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { JobAssignmentsService } from './job-assignments.service';
import { AssignJobDto, type JobAssignmentResponse } from './dto/job-assignment.dto';

/**
 * FR1 / §24.2 — the hiring team on a requisition (amendment A1, decision B1).
 *
 * RECRUITER AND ADMIN WRITE; HIRING_MANAGER IS ABSENT, and that omission is the
 * security property this controller exists to hold. A Hiring Manager is the
 * role `job_assignments` NARROWS — letting them add a row would let them widen
 * their own access to any requisition in the tenant, and to the candidate data,
 * scorecards and interviews behind it. Assignment is therefore a job-management
 * action, sitting with the other job mutations (`POST /v1/jobs`,
 * `PATCH /v1/jobs/:id`, `POST /v1/jobs/:id/duplicate`), all Recruiter+Admin.
 *
 * A SEPARATE CONTROLLER FROM `JobsController`, following `PublicJobsController`
 * and `TagsController`: these routes are about who may reach a job rather than
 * about the job's own fields, and keeping them apart means the access-control
 * surface is one file rather than three methods buried among CRUD.
 *
 * `@JobScoped()` supplies tenancy and the 404-not-403 refusal on every route,
 * so no route here re-implements either.
 */
@ApiTags('jobs')
@Controller('jobs')
export class JobAssignmentsController {
  constructor(private readonly assignments: JobAssignmentsService) {}

  @Get(':id/assignments')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @JobScoped()
  @ApiOperation({ summary: 'List the users assigned to a job (§24.2)' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: JobAssignmentResponse[] }> {
    // Wrapped in `data` like every other list this API returns, though an
    // assignment set is far too small to need a cursor.
    return { data: await this.assignments.list(user, id) };
  }

  /**
   * The audited resource is the JOB, not the assignment row.
   *
   * `resource_id` names what a reader would search the trail by — "who could
   * see this requisition, and when did that change?" — and an assignment id is
   * a value nobody holds. The affected colleague travels in `afterState`.
   */
  @Post(':id/assignments')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @JobScoped()
  @Audit({ action: 'job.assignment_added', resourceType: 'job' })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Assign a hiring manager or administrator to a job (§24.2)' })
  async add(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignJobDto,
    @Req() req: RequestContext,
  ): Promise<JobAssignmentResponse> {
    const assignment = await this.assignments.add(user, id, dto.userId);

    req.auditState = {
      before: null,
      after: { userId: assignment.userId, email: assignment.email, role: assignment.role },
    };

    return assignment;
  }

  @Delete(':id/assignments/:userId')
  @Roles(UserRole.RECRUITER, UserRole.ADMIN)
  @JobScoped()
  @Audit({ action: 'job.assignment_removed', resourceType: 'job' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a user’s assignment from a job (§24.2)' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: RequestContext,
  ): Promise<void> {
    const removed = await this.assignments.remove(user, id, userId);

    // The revoked access, so the trail records WHAT stopped applying.
    req.auditState = {
      before: { userId: removed.userId, email: removed.email, role: removed.role },
      after: null,
    };
  }
}
