import { Module } from '@nestjs/common';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

/**
 * FR5.1–FR5.4 — pipeline stages and their history.
 *
 * Scorecards live in a separate ScorecardsModule (Handoff §H), not here.
 * PrismaService arrives from the global CommonModule.
 */
@Module({
  controllers: [PipelineController],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}
