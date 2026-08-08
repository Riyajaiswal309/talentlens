import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
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
  providers: [AuditService],
  exports: [AuditService, PrismaModule],
})
export class CommonModule {}
