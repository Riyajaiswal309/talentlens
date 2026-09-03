import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole, type ParsedProfile } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import {
  CONFIDENCE_THRESHOLD,
  isKnownFieldPath,
  type FieldCorrection,
  type ParseReviewQueryDto,
} from './dto/parse-review.dto';

const DEFAULT_PAGE_SIZE = 25;

export interface FlaggedField {
  field: string;
  extractedValue: unknown;
  confidence: number;
}

export interface ReviewItem {
  applicationId: string;
  parsedProfileId: string;
  candidateName: string;
  flaggedFields: FlaggedField[];
}

type ConfidenceMap = Record<string, number>;
type ConfirmationMap = Record<string, { by: string; at: string }>;

/** Resolve `work_history[0].employer` against the stored profile. */
function readFieldPath(profile: ParsedProfile, path: string): unknown {
  const [root, ...rest] = path.split('.');
  const match = /^([a-z_]+)(?:\[(\d+)\])?$/.exec(root ?? '');
  if (!match) return undefined;

  const column: Record<string, unknown> = {
    skills: profile.skills,
    work_history: profile.workHistory,
    education: profile.education,
    certifications: profile.certifications,
  };

  let value: unknown = column[match[1] as string];
  if (match[2] !== undefined && Array.isArray(value)) {
    value = value[Number(match[2])];
  }
  for (const segment of rest) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** The four JSON columns a field path may address, by their path root. */
const COLUMN_BY_ROOT = {
  contact: 'contact',
  skills: 'skills',
  work_history: 'workHistory',
  education: 'education',
  certifications: 'certifications',
} as const;

type ColumnRoot = keyof typeof COLUMN_BY_ROOT;

/**
 * Apply a corrected value at `path`, returning the column patches to persist.
 *
 * THE VALUE IS ACTUALLY WRITTEN. `patch` previously updated only confidence and
 * confirmations, so a "correction" recorded that a human had looked at a field
 * while leaving the parser's wrong value in place — and everything downstream,
 * the scorer included, went on reading the wrong value.
 *
 * Only the roots `isKnownFieldPath` already admitted are reachable, and the
 * segment names are constrained to `[a-z_]+` by that same grammar, so no
 * `__proto__` or `constructor` key can be addressed here.
 */
function writeFieldPath(
  profile: ParsedProfile,
  path: string,
  value: unknown,
): Partial<Record<(typeof COLUMN_BY_ROOT)[ColumnRoot], unknown>> | null {
  const [head, ...rest] = path.split('.');
  const match = /^([a-z_]+)(?:\[(\d+)\])?$/.exec(head ?? '');
  if (!match) return null;

  const root = match[1] as ColumnRoot;
  if (!(root in COLUMN_BY_ROOT)) return null;

  const index = match[2];

  const column = COLUMN_BY_ROOT[root];
  // Cloned, never mutated in place: Prisma hands back the stored JSON and a
  // mutation would make the "before" snapshot in the audit record untrue.
  const current = structuredClone(profile[column]) as unknown;

  // `skills` — the whole array.
  if (index === undefined && rest.length === 0) {
    return { [column]: value };
  }

  // `skills[1]` — one element.
  if (index !== undefined && rest.length === 0) {
    if (!Array.isArray(current)) return null;
    const next = [...current];
    next[Number(index)] = value;
    return { [column]: next };
  }

  // `contact.name`, `education[0].degree` — a leaf inside an object.
  const container =
    index === undefined ? current : Array.isArray(current) ? current[Number(index)] : undefined;

  if (container === null || typeof container !== 'object') return null;

  let cursor = container as Record<string, unknown>;
  for (const segment of rest.slice(0, -1)) {
    const next = cursor[segment];
    if (next === null || typeof next !== 'object') return null;
    cursor = next as Record<string, unknown>;
  }
  cursor[rest[rest.length - 1] as string] = value;

  return { [column]: current };
}

@Injectable()
export class ParseReviewService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR3.2 — fields the parser was not confident about.
   *
   * "A per-field parsing confidence score is generated; fields below the
   * configured threshold are flagged for review rather than silently
   * accepted." The queue is derived from `field_confidence`; nothing is
   * marked reviewed by the system itself.
   */
  static flagged(profile: ParsedProfile): FlaggedField[] {
    const confidence = (profile.fieldConfidence ?? {}) as ConfidenceMap;

    return Object.entries(confidence)
      .filter(([, score]) => score < CONFIDENCE_THRESHOLD)
      .map(([field, score]) => ({
        field,
        extractedValue: readFieldPath(profile, field),
        confidence: score,
      }))
      .sort((a, b) => a.confidence - b.confidence);
  }

  /** GET /v1/jobs/:id/parse-review — Recruiter, Administrator. */
  async listForJob(
    user: AuthenticatedUser,
    jobId: string,
    query: ParseReviewQueryDto,
  ): Promise<{ data: ReviewItem[]; nextCursor: string | null }> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, companyId: user.companyId },
      select: { id: true },
    });
    if (!job) throw new NotFoundException();

    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const rows = await this.prisma.application.findMany({
      where: { jobId: job.id, resume: { parsedProfile: { isNot: null } } },
      include: {
        candidate: { select: { fullName: true } },
        resume: { include: { parsedProfile: true } },
      },
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const data = page
      .map((application) => {
        const profile = application.resume?.parsedProfile;
        if (!profile) return null;
        const flaggedFields = ParseReviewService.flagged(profile);
        // Only profiles that actually need a human belong in a review queue.
        if (flaggedFields.length === 0) return null;

        return {
          applicationId: application.id,
          parsedProfileId: profile.id,
          candidateName: application.candidate.fullName,
          flaggedFields,
        };
      })
      .filter((item): item is ReviewItem => item !== null);

    return { data, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
  }

  /**
   * Resolve a profile the caller may correct (Gap 3 rules 3 and 4).
   *
   * A CANDIDATE reaches only a profile on their own application; everyone
   * else is tenant-scoped through the job. Hiring Managers are refused by
   * RolesGuard before reaching here — §24.2 gives them no correction rights.
   */
  private async findWritable(user: AuthenticatedUser, profileId: string) {
    const profile = await this.prisma.parsedProfile.findFirst({
      where: {
        id: profileId,
        resume: {
          application:
            user.role === UserRole.CANDIDATE
              ? { candidate: { userId: user.id } }
              : { job: { companyId: user.companyId } },
        },
      },
      include: { resume: { select: { applicationId: true } } },
    });

    if (!profile) throw new NotFoundException();
    return profile;
  }

  /**
   * PATCH /v1/parsed-profiles/:id — FR2.2 / FR3.2 correction.
   *
   * Gap 3 rule 4: confirming a field sets its confidence to 1.0 and records
   * the actor. The value itself is written back to the column the path names,
   * so a corrected profile is the one everything downstream reads.
   */
  async patch(
    user: AuthenticatedUser,
    profileId: string,
    fields: Record<string, FieldCorrection>,
  ): Promise<{ before: ParsedProfile; after: ParsedProfile; confirmed: string[] }> {
    const before = await this.findWritable(user, profileId);

    const paths = Object.keys(fields);
    if (paths.length === 0) {
      throw new BadRequestException('Supply at least one field to correct');
    }

    // Gap 3 rule 1 — arbitrary keys rejected, named individually so the
    // caller can see which one was wrong.
    const unknown = paths.filter((path) => !isKnownFieldPath(path));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown field path(s): ${unknown.join(', ')}`);
    }

    const confidence = { ...((before.fieldConfidence ?? {}) as ConfidenceMap) };
    const confirmations = { ...((before.fieldConfirmations ?? {}) as ConfirmationMap) };
    const confirmed: string[] = [];
    const now = new Date().toISOString();

    /*
     * Two separate effects, and they are not the same thing. The VALUE is
     * written whenever one is supplied — that is the correction. `confirmed`
     * additionally pins confidence to 1.0 and records who vouched for it, which
     * is what takes the field out of the review queue. A caller may correct
     * without confirming, and the queue will still show the field.
     */
    const columnPatches: Record<string, unknown> = {};

    for (const [path, correction] of Object.entries(fields)) {
      const patched = writeFieldPath(
        { ...before, ...columnPatches } as ParsedProfile,
        path,
        correction.value,
      );
      if (!patched) {
        throw new BadRequestException(`Field path does not resolve in this profile: ${path}`);
      }
      Object.assign(columnPatches, patched);

      if (correction.confirmed) {
        confidence[path] = 1;
        confirmations[path] = { by: user.id, at: now };
        confirmed.push(path);
      }
    }

    const after = await this.prisma.parsedProfile.update({
      where: { id: before.id },
      data: {
        ...(columnPatches as Prisma.ParsedProfileUpdateInput),
        fieldConfidence: confidence,
        fieldConfirmations: confirmations,
      },
    });

    return { before, after, confirmed };
  }
}
