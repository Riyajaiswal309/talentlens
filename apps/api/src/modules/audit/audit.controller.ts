import {
  All,
  Controller,
  Get,
  MethodNotAllowedException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuditActorType } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { EXPORT_ACTION } from './audit-actions';
import { AuditExportService } from './audit-export.service';
import { AuditQueryService, type AuditEntry } from './audit-query.service';
import { ExportAuditDto, QueryAuditDto } from './dto/query-audit.dto';

/** Gap 4 list row. */
interface AuditRowResponse {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
}

function toRow(entry: AuditEntry): AuditRowResponse {
  return {
    id: entry.id,
    createdAt: entry.createdAt.toISOString(),
    actorId: entry.actorId,
    // [PROP] denormalisation — AD-04 shows who acted, not an opaque uuid.
    actorEmail: entry.actor?.email ?? null,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
  };
}

/**
 * FR8.3 / NFR8 — the audit browser and export
 * (Handoff §B rows 25–27, Gap 4, Phase 1 AD-04 and AD-05).
 *
 * Administrator only (PRD §24.2 "Export audit log — Admin ✓").
 *
 * READ-ONLY BY CONSTRUCTION. `audit_logs` carries no UPDATE or DELETE grant
 * for the application role (PRD §17.3), so a write verb could not succeed
 * even if one existed. The explicit 405 below says so at the API surface
 * rather than letting a caller infer it from a 404.
 */
@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  constructor(
    private readonly audit: AuditQueryService,
    private readonly exporter: AuditExportService,
    private readonly auditWriter: AuditService,
  ) {}

  @Get('export')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Export the audit trail as CSV or JSON (FR8.3)',
    description: 'Streamed. Same filters as the browser. Max span 366 days.',
  })
  async export(
    @CurrentUser() admin: AuthenticatedUser,
    @Query() query: ExportAuditDto,
    @Req() req: RequestContext,
    @Res() res: Response,
  ): Promise<void> {
    const entries = await this.audit.findAllForExport(admin, query);
    const format = query.format ?? 'json';
    const stamp = new Date().toISOString().slice(0, 10);

    /*
     * The export is itself an auditable event (Handoff §I), written HERE
     * rather than by AuditInterceptor.
     *
     * This handler owns the response — it streams with @Res() and calls
     * res.end() itself — so an interceptor record would land after the bytes
     * had already gone out, breaking PRD §15.1 principle 4. Writing first
     * keeps "audit before response" true for this route too. If the write
     * throws, the export never starts, which is the BR-03 behaviour.
     *
     * `findAllForExport` excludes `audit.exported`, so this row can never
     * appear inside an export — including its own.
     */
    if (!req.correlationId) {
      throw new Error('CorrelationIdMiddleware did not run before AuditController');
    }

    await this.auditWriter.record({
      companyId: admin.companyId,
      actorId: admin.id,
      actorType: AuditActorType.USER,
      action: EXPORT_ACTION,
      resourceType: 'audit_log',
      resourceId: admin.companyId,
      correlationId: req.correlationId,
      afterState: { format, rowCount: entries.length, filters: { ...query } },
    });

    res.setHeader(
      'Content-Type',
      format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
    );
    res.setHeader('Content-Disposition', `attachment; filename="audit-${stamp}.${format}"`);
    res.setHeader('X-Total-Count', String(entries.length));

    const chunks = format === 'csv' ? this.exporter.toCsv(entries) : this.exporter.toJson(entries);
    for await (const chunk of chunks) {
      res.write(chunk);
    }
    res.end();
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Filter the audit trail (FR8.3, NFR8, §9.3)' })
  async list(
    @CurrentUser() admin: AuthenticatedUser,
    @Query() query: QueryAuditDto,
  ): Promise<{ data: AuditRowResponse[]; nextCursor: string | null; totalCount: number }> {
    const { data, nextCursor, totalCount } = await this.audit.list(admin, query);
    return { data: data.map(toRow), nextCursor, totalCount };
  }

  @Get(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'One entry, with before/after state and model provenance' })
  async findOne(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const { entry, modelVersion, overrideReason } = await this.audit.findOne(admin, id);

    return {
      ...toRow(entry),
      actorType: entry.actorType,
      beforeState: entry.beforeState,
      afterState: entry.afterState,
      correlationId: entry.correlationId,
      // Gap 4: present only where the entry references a match_score.
      modelVersion,
      overrideReason,
    };
  }

  /**
   * Gap 4 validation rule 3 — no write verbs exist on this resource.
   *
   * Two handlers, not one: a stacked pair of @All decorators registers only
   * the last, and both the collection (POST /audit-logs) and an entry
   * (PATCH /audit-logs/:id) have to be covered.
   *
   * Declared last so they catch only what the GETs above did not. Without
   * them Nest answers 404, which would read as "no such entry" when the truth
   * is "this resource is append-only".
   */
  @All()
  @Roles(UserRole.ADMIN)
  rejectCollectionMutation(): never {
    return this.refuse();
  }

  @All('*')
  @Roles(UserRole.ADMIN)
  rejectEntryMutation(): never {
    return this.refuse();
  }

  private refuse(): never {
    throw new MethodNotAllowedException('The audit trail is append-only (PRD §17.3)');
  }
}
