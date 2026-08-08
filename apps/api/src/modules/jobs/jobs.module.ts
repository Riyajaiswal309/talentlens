import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { PublicJobsController } from './public-jobs.controller';

/**
 * FR1.1–FR1.4. PrismaService arrives from the global CommonModule.
 *
 * PublicJobsController is a separate controller rather than extra routes on
 * JobsController: every route on the latter is role-guarded, and mixing
 * anonymous routes into it would make "which of these is public?" a question
 * answered per-method instead of per-file.
 */
@Module({
  controllers: [JobsController, PublicJobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
