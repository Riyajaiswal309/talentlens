import { Injectable, NotFoundException } from '@nestjs/common';
import { UserRole, type Comment, type Users } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';

export type CommentWithAuthor = Comment & { author: Pick<Users, 'id' | 'email' | 'role'> };

const AUTHOR_FIELDS = { select: { id: true, email: true, role: true } } as const;

/**
 * FR5.3 — the comments half.
 *
 * "Comments and scorecards are visible to the full hiring team for each
 * candidate." Scorecards shipped in M2.8; comments had no table until now, so
 * the requirement was only half delivered despite the Handoff marking it
 * "✅ Full".
 *
 * Deliberately the same shape as ScorecardsService: same visibility rule,
 * same tenancy resolution, same Hiring Manager assignment check. Two halves
 * of one requirement should not diverge in who can see them.
 */
@Injectable()
export class CommentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The application this caller may discuss, or 404.
   *
   * Tenant through the job (`applications` has no company_id, PRD §17.2), and
   * a Hiring Manager additionally only on jobs they are assigned to (§24.2).
   * Refusals are 404, never 403 (BR-06).
   */
  private async findVisibleApplication(user: AuthenticatedUser, applicationId: string) {
    const application = await this.prisma.application.findFirst({
      where: {
        id: applicationId,
        job: {
          companyId: user.companyId,
          ...(user.role === UserRole.HIRING_MANAGER
            ? { assignments: { some: { userId: user.id } } }
            : {}),
        },
      },
      select: { id: true },
    });

    if (!application) throw new NotFoundException();
    return application;
  }

  async create(
    user: AuthenticatedUser,
    applicationId: string,
    body: string,
  ): Promise<CommentWithAuthor> {
    await this.findVisibleApplication(user, applicationId);

    return this.prisma.comment.create({
      data: { applicationId, authorId: user.id, body: body.trim() },
      include: { author: AUTHOR_FIELDS },
    });
  }

  /** The whole thread, oldest first — a conversation reads forwards. */
  async list(user: AuthenticatedUser, applicationId: string): Promise<CommentWithAuthor[]> {
    await this.findVisibleApplication(user, applicationId);

    return this.prisma.comment.findMany({
      where: { applicationId },
      include: { author: AUTHOR_FIELDS },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}
