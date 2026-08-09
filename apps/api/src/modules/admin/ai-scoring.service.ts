import { Injectable, NotFoundException } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';

@Injectable()
export class AiScoringAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR8.2 — flip `jobs.ai_scoring_enabled` for one requisition.
   *
   * Writes that column and nothing else. It is the only field this service
   * touches, which is what keeps BR-04's boundary legible: an administrator
   * gains the toggle here without gaining the recruiter's edit rights.
   *
   * Tenant-scoped, 404 on a foreign job (BR-06). No AI runs either way — with
   * the null provider the flag changes what Phase 3 will do, not what Phase 2
   * does, and no path here can touch an application's stage (BR-01).
   */
  async setEnabled(
    admin: AuthenticatedUser,
    jobId: string,
    enabled: boolean,
  ): Promise<{ before: Job; after: Job }> {
    const before = await this.prisma.job.findFirst({
      where: { id: jobId, companyId: admin.companyId },
    });
    if (!before) throw new NotFoundException();

    const after = await this.prisma.job.update({
      where: { id: before.id },
      data: { aiScoringEnabled: enabled },
    });

    return { before, after };
  }
}
