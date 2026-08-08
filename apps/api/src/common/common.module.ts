import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { CandidateOwnershipGuard } from './guards/candidate-ownership.guard';
import { JobAssignmentGuard } from './guards/job-assignment.guard';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Providers shared by every feature module.
 *
 * The guards, interceptors and filter themselves are registered GLOBALLY in
 * main.ts rather than here, so they cannot be forgotten when a new module is
 * added. That is the R-09 mitigation the PRD asks for: framework-level
 * enforcement instead of per-service discipline.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [AuditService, CandidateOwnershipGuard, JobAssignmentGuard],
  exports: [AuditService, CandidateOwnershipGuard, JobAssignmentGuard, PrismaModule],
})
export class CommonModule {}
