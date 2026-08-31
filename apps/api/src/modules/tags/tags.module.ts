import { Module } from '@nestjs/common';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';

/**
 * FR5.2 — application tags.
 *
 * Its own module rather than an addition to PipelineModule: tags hang off an
 * application, not off a stage, and the pipeline module is deliberately about
 * stages and their history. `PrismaService` and `AuditService` arrive from the
 * global CommonModule.
 */
@Module({
  controllers: [TagsController],
  providers: [TagsService],
})
export class TagsModule {}
