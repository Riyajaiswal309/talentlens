import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { CommentsService, type CommentWithAuthor } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';

interface CommentResponse {
  id: string;
  body: string;
  author: { id: string; email: string; role: string };
  createdAt: string;
}

function toResponse(comment: CommentWithAuthor): CommentResponse {
  return {
    id: comment.id,
    body: comment.body,
    author: { id: comment.author.id, email: comment.author.email, role: comment.author.role },
    createdAt: comment.createdAt.toISOString(),
  };
}

/**
 * FR5.3 — team comments on a candidate (Phase 1 RC-06 footer, HM-03).
 *
 * Recruiter, Hiring Manager and Admin — the same set that may submit a
 * scorecard, because §24.2 treats both as hiring-team collaboration and
 * FR5.3 names them in one breath.
 *
 * CANDIDATES ARE ABSENT. A comment is the team talking about the candidate,
 * not to them; nothing here is reachable by the person being discussed.
 *
 * Not audited: Handoff §I's vocabulary has no comment event, and inventing
 * one would extend a list the Handoff fixes deliberately. Recorded as an
 * amendment rather than assumed.
 */
@ApiTags('collaboration')
@Controller('applications')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Post(':id/comments')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a comment to a candidate (FR5.3)' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCommentDto,
  ): Promise<CommentResponse> {
    return toResponse(await this.comments.create(user, id, dto.body));
  }

  @Get(':id/comments')
  @Roles(UserRole.RECRUITER, UserRole.HIRING_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'The comment thread, visible to the whole team (FR5.3)' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: CommentResponse[] }> {
    const comments = await this.comments.list(user, id);
    return { data: comments.map(toResponse) };
  }
}
