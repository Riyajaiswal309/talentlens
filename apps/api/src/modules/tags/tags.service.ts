import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditActorType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import type { BulkTagResponse, TagResponse } from './dto/tag.dto';

/**
 * FR5.2 — application tags.
 *
 * TENANCY IS REACHED THROUGH THE JOB, as everywhere else that touches an
 * application: `applications` carries no `company_id`, so every query here is
 * scoped by `application.job.companyId`. A tag on another tenant's application
 * is refused with 404, never 403 (BR-06) — a 403 would confirm the id exists.
 */
@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Resolve an application the caller may act on, or refuse.
   *
   * A HIRING MANAGER IS NARROWED TO ASSIGNED JOBS, matching how every other
   * hiring-team surface treats that role (§24.2 "assigned jobs only"). A
   * Recruiter or Administrator sees the whole tenant.
   */
  private async findWritable(user: AuthenticatedUser, applicationId: string) {
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
      include: { job: { select: { id: true, companyId: true } } },
    });

    // BR-06 — indistinguishable from "does not exist".
    if (!application) throw new NotFoundException();
    return application;
  }

  async list(user: AuthenticatedUser, applicationId: string): Promise<TagResponse[]> {
    await this.findWritable(user, applicationId);

    const tags = await this.prisma.applicationTag.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { email: true } } },
    });

    return tags.map(toResponse);
  }

  async add(
    user: AuthenticatedUser,
    applicationId: string,
    label: string,
    correlationId: string,
  ): Promise<TagResponse> {
    const application = await this.findWritable(user, applicationId);

    let tag;
    try {
      tag = await this.prisma.applicationTag.create({
        data: { applicationId, label, createdBy: user.id },
        include: { author: { select: { email: true } } },
      });
    } catch (error) {
      /*
       * P2002 from the case-insensitive unique index. Reported as 409 rather
       * than silently succeeding: the recruiter asked for something the record
       * already says, and telling them so is more useful than a no-op that
       * looks like a fresh addition.
       */
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`This application is already tagged “${label}”`);
      }
      throw error;
    }

    await this.audit.record({
      companyId: application.job.companyId,
      actorId: user.id,
      actorType: AuditActorType.USER,
      action: 'application.tagged',
      resourceType: 'application',
      resourceId: applicationId,
      correlationId,
      afterState: { label },
    });

    return toResponse(tag);
  }

  /**
   * FR5.2 — apply one tag to many applications.
   *
   * AUTHORISATION IS ONE QUERY, NOT A LOOP. The accessible set is resolved with
   * the same `where` the single-tag path uses, so tenancy and the Hiring
   * Manager's assignment narrowing cannot drift between them. Anything the
   * caller asked for that is not in that set is REPORTED in `failed` — never
   * silently dropped — with the same wording for "does not exist" and "another
   * tenant's", per BR-06.
   *
   * NOT ALL-OR-NOTHING, matching the existing bulk stage change: a selection of
   * twelve where one id is stale should tag the eleven and say so, rather than
   * refuse the lot. Each insert is atomic in itself; the batch reports outcomes.
   *
   * ALREADY-TAGGED IS NOT AN ERROR. Re-applying a tag someone else already
   * added is a no-op, so it is separated from `tagged` and emits NO audit row —
   * an audit entry for a write that did not happen would be a false record.
   */
  async bulkAdd(
    user: AuthenticatedUser,
    applicationIds: string[],
    label: string,
    correlationId: string,
  ): Promise<BulkTagResponse> {
    // Duplicates within the caller's own selection collapse to one.
    const requested = [...new Set(applicationIds)];

    const accessible = await this.prisma.application.findMany({
      where: {
        id: { in: requested },
        job: {
          companyId: user.companyId,
          ...(user.role === UserRole.HIRING_MANAGER
            ? { assignments: { some: { userId: user.id } } }
            : {}),
        },
      },
      select: { id: true, job: { select: { companyId: true } } },
    });

    const accessibleIds = new Set(accessible.map((a) => a.id));
    const failed = requested
      .filter((id) => !accessibleIds.has(id))
      .map((id) => ({
        id,
        // Deliberately identical for missing and cross-tenant (BR-06): a
        // distinct message would confirm the record exists elsewhere.
        reason: 'Not found, or not available to you',
      }));

    /*
     * Case-insensitive, because the database's unique index is. Checking here
     * as well is not a duplicate of that guarantee — it is how `alreadyTagged`
     * is distinguished from `tagged` for reporting. The index remains the
     * authority: a concurrent insert still loses on P2002 below.
     */
    const existing = await this.prisma.applicationTag.findMany({
      where: {
        applicationId: { in: [...accessibleIds] },
        label: { equals: label, mode: 'insensitive' },
      },
      select: { applicationId: true },
    });
    const alreadyTagged = existing.map((t) => t.applicationId);
    const alreadySet = new Set(alreadyTagged);
    const toTag = [...accessibleIds].filter((id) => !alreadySet.has(id));

    const tagged: string[] = [];
    for (const applicationId of toTag) {
      try {
        await this.prisma.applicationTag.create({
          data: { applicationId, label, createdBy: user.id },
        });
        tagged.push(applicationId);
      } catch (error) {
        // Lost a race against a concurrent add — the tag is present either
        // way, so this is `alreadyTagged`, not a failure.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          alreadyTagged.push(applicationId);
          continue;
        }
        throw error;
      }
    }

    /*
     * One audit row per application ACTUALLY tagged. Not one row for the batch:
     * `audit_logs.resource_id` names a single resource, and a batch id would
     * make the trail unsearchable by application. Nothing is written for
     * already-tagged or failed ids.
     */
    const companyId = accessible[0]?.job.companyId ?? user.companyId;
    for (const applicationId of tagged) {
      await this.audit.record({
        companyId,
        actorId: user.id,
        actorType: AuditActorType.USER,
        action: 'application.tagged',
        resourceType: 'application',
        resourceId: applicationId,
        correlationId,
        // `bulk` marks how it happened, so a reader can tell a batch from a
        // deliberate single tag.
        afterState: { label, bulk: true },
      });
    }

    return { label, tagged, alreadyTagged, failed };
  }

  async remove(
    user: AuthenticatedUser,
    applicationId: string,
    tagId: string,
    correlationId: string,
  ): Promise<void> {
    const application = await this.findWritable(user, applicationId);

    /*
     * Scoped to the application as well as the id, so a tag id from another
     * application cannot be deleted by guessing it — the tag must belong to the
     * record the caller has already proved access to.
     */
    const tag = await this.prisma.applicationTag.findFirst({
      where: { id: tagId, applicationId },
    });
    if (!tag) throw new NotFoundException();

    await this.prisma.applicationTag.delete({ where: { id: tag.id } });

    await this.audit.record({
      companyId: application.job.companyId,
      actorId: user.id,
      actorType: AuditActorType.USER,
      action: 'application.untagged',
      resourceType: 'application',
      resourceId: applicationId,
      correlationId,
      // The removed value, so the trail records WHAT stopped applying.
      beforeState: { label: tag.label },
    });
  }
}

function toResponse(tag: {
  id: string;
  label: string;
  createdAt: Date;
  author: { email: string };
}): TagResponse {
  return {
    id: tag.id,
    label: tag.label,
    createdAt: tag.createdAt.toISOString(),
    createdByEmail: tag.author.email,
  };
}
