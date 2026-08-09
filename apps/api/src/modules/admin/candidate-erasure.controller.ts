import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser, RequestContext } from '../../common/types/authenticated-request';
import { CandidateErasureService } from './candidate-erasure.service';

/**
 * BR-05 — right to erasure (PRD §17.1, §18, §24.5 GDPR/CCPA).
 *
 * NOT IN PRD §23.2. BR-05 specifies the routine and Handoff §I names the
 * `candidate.erased` action, but no endpoint was ever written down. This is
 * the smallest surface that satisfies the rule: Administrator only, one
 * candidate, tenant-scoped. Recorded as an amendment.
 *
 * DELETE is the honest verb for the request even though the row survives —
 * the caller is asking for erasure, and §18 dictates that this is expressed
 * as detachment rather than deletion.
 */
@ApiTags('admin')
@Controller('admin/candidates')
export class CandidateErasureController {
  constructor(private readonly erasure: CandidateErasureService) {}

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @Audit({ action: 'candidate.erased', resourceType: 'candidate' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Erase a candidate’s personal data (BR-05)',
    description:
      'Detaches PII and deletes stored resumes. Applications, stage history and ' +
      'the audit trail are retained: PRD §18 requires the audit skeleton to survive.',
  })
  async erase(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestContext,
  ): Promise<{ candidateId: string; applicationsRetained: number; erasedAt: string }> {
    const result = await this.erasure.erase(admin, id);

    /*
     * The before-state deliberately carries no PII. An audit record of an
     * erasure that quoted the erased name would preserve exactly what the
     * request asked to remove.
     */
    req.auditState = { before: null, after: CandidateErasureService.toAuditState(result) };

    return {
      candidateId: result.candidateId,
      applicationsRetained: result.applicationsRetained,
      erasedAt: result.erasedAt.toISOString(),
    };
  }
}
