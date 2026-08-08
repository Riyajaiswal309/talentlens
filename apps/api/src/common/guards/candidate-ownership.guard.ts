import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import {
  CANDIDATE_OWNED_KEY,
  type CandidateOwnedMetadata,
} from '../decorators/resource-access.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../types/authenticated-request';

/**
 * BR-06 — "Access to candidate PII is restricted by role; candidates may view
 * only their own application data."
 *
 * WHY 404 AND NOT 403
 * PRD §26 requires that "a candidate token requesting another candidate's
 * application must receive 404, not 403, to avoid existence disclosure".
 * A 403 would confirm the record exists, letting an attacker enumerate
 * application ids. Every refusal here is therefore indistinguishable from
 * "no such record".
 *
 * WHY ONLY THE CANDIDATE ROLE
 * Recruiters, Hiring Managers and Administrators legitimately read candidate
 * data within their tenant; their limits come from RolesGuard, TenantGuard
 * and JobAssignmentGuard. This guard exists solely to stop one candidate
 * reaching another's data.
 *
 * Relies on the approved candidate-identity resolution (8 Aug 2026):
 * candidates.user_id is a nullable, unique FK to users(id).
 */
@Injectable()
export class CandidateOwnershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<CandidateOwnedMetadata | undefined>(
      CANDIDATE_OWNED_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Route is not candidate-owned; nothing to enforce.
    if (!metadata) return true;

    const request = context.switchToHttp().getRequest<RequestContext>();
    const user = request.user;

    // Public route, or a role governed by the other guards.
    if (!user || user.role !== UserRole.CANDIDATE) return true;

    const resourceId = readParam(request, metadata.param ?? 'id');
    if (!resourceId) throw new NotFoundException();

    /*
     * Resolve this login to its candidate profile.
     *
     * A CANDIDATE user with no linked profile is legitimate — the approved
     * resolution states a profile may exist without an account and, by
     * symmetry, an account may exist before a profile. Such a user simply
     * owns nothing yet, so every owned resource is 404 to them.
     */
    const profile = await this.prisma.candidate.findUnique({
      where: { userId: user.id },
      select: { id: true, deletedAt: true },
    });

    // BR-05 — an erased candidate must not reach their own data either.
    if (!profile || profile.deletedAt) throw new NotFoundException();

    const owns = await this.ownsResource(metadata.resource, resourceId, profile.id);
    if (!owns) throw new NotFoundException();

    return true;
  }

  private async ownsResource(
    resource: CandidateOwnedMetadata['resource'],
    resourceId: string,
    candidateId: string,
  ): Promise<boolean> {
    switch (resource) {
      case 'application': {
        const application = await this.prisma.application.findFirst({
          where: { id: resourceId, candidateId },
          select: { id: true },
        });
        return application !== null;
      }
      case 'candidate':
        // A candidate may only address their own profile.
        return resourceId === candidateId;
      default:
        // Unreachable while OwnedResource is exhaustive, but a new member
        // must fail closed rather than silently granting access.
        return false;
    }
  }
}

function readParam(request: RequestContext, name: string): string | undefined {
  const value = request.params?.[name];
  return typeof value === 'string' ? value : undefined;
}
