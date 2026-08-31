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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { TagsService } from './tags.service';
import { AddTagDto, BulkAddTagDto, type BulkTagResponse, type TagResponse } from './dto/tag.dto';

/**
 * FR5.2 — application tags, for the hiring team only.
 *
 * NO CANDIDATE ANYWHERE ON THIS CONTROLLER, and that is the whole access
 * decision. A tag is the team's shorthand about a person; §24.2 gives the
 * subject of an assessment no view of the team's working notes, which is the
 * same rule that withholds `score`, `source` and stage history. Omitting the
 * role is stronger than filtering the response: a Candidate cannot read these
 * routes at all, let alone write them.
 *
 * HIRING_MANAGER is included, matching `comments` — an assigned reviewer
 * contributes to the record. `TagsService` narrows them to assigned jobs.
 */
@ApiTags('applications')
@Controller('applications')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  /**
   * FR5.2 — one tag, many applications.
   *
   * DECLARED BEFORE `:id/tags`, and that ordering is load-bearing: Nest matches
   * routes in declaration order, so with `:id` first the literal segment `bulk`
   * would be captured as an application id and rejected by `ParseUUIDPipe` as a
   * 400. The bulk stage endpoint sits above `:id/stage` for the same reason.
   */
  @Post('bulk/tags')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Apply one tag to several applications (FR5.2)' })
  @HttpCode(HttpStatus.OK)
  async bulkAdd(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkAddTagDto,
    @Req() req: RequestContext,
  ): Promise<BulkTagResponse> {
    return this.tags.bulkAdd(user, dto.applicationIds, dto.label, req.correlationId ?? '');
  }

  @Get(':id/tags')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'List the tags on an application (FR5.2)' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: TagResponse[] }> {
    // Wrapped in `data` to match every other list this API returns, even
    // though a tag set is small enough never to need a cursor.
    return { data: await this.tags.list(user, id) };
  }

  @Post(':id/tags')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Add a tag to an application (FR5.2)' })
  async add(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTagDto,
    @Req() req: RequestContext,
  ): Promise<TagResponse> {
    return this.tags.add(user, id, dto.label, req.correlationId ?? '');
  }

  @Delete(':id/tags/:tagId')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a tag from an application (FR5.2)' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @Req() req: RequestContext,
  ): Promise<void> {
    await this.tags.remove(user, id, tagId, req.correlationId ?? '');
  }
}
