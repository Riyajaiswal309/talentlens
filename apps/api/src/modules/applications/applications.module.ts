import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { JobCandidatesController } from './job-candidates.controller';

/**
 * FR2.1 public intake, including resume upload and storage.
 *
 * StorageService and ResumeScanner come from the global CommonModule, so no
 * import is needed here. AiModule is imported explicitly because the AI seam
 * is a real module boundary (PRD §15.3), not global infrastructure.
 */
@Module({
  imports: [AiModule],
  controllers: [ApplicationsController, JobCandidatesController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
