import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { CandidateOwnershipGuard } from './guards/candidate-ownership.guard';
import { JobAssignmentGuard } from './guards/job-assignment.guard';
import { PrismaModule } from './prisma/prisma.module';
import { IdempotencyService } from './idempotency/idempotency.service';
import { ResumeQueueService } from './queue/resume-queue.service';
import { PassThroughScanner, ResumeScanner } from './storage/resume-scanner';
import { StorageService } from './storage/storage.service';

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
  providers: [
    AuditService,
    CandidateOwnershipGuard,
    JobAssignmentGuard,
    StorageService,
    ResumeQueueService,
    IdempotencyService,
    /*
     * The antivirus boundary is bound to its implementation in ONE place
     * (approved decision B1). Replacing the pass-through with a real ClamAV
     * client is this line and nothing else — no caller references the
     * concrete class.
     */
    { provide: ResumeScanner, useClass: PassThroughScanner },
  ],
  exports: [
    AuditService,
    CandidateOwnershipGuard,
    JobAssignmentGuard,
    StorageService,
    ResumeScanner,
    ResumeQueueService,
    IdempotencyService,
    PrismaModule,
  ],
})
export class CommonModule {}
