import { Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { JobCandidatesController } from './job-candidates.controller';

/**
 * FR2.1 public intake, including resume upload and storage.
 *
 * StorageService and ResumeScanner come from the global CommonModule, so no
 * import is needed here.
 */
@Module({
  controllers: [ApplicationsController, JobCandidatesController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
