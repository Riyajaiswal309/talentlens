import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * FR7.1–FR7.2 — analytics (PRD §15.3 `AnalyticsModule`).
 *
 * Deferred out of Phase 2 by Handoff decision D3 and built here, in Phase 2b.
 *
 * Read-only. It owns no tables and writes nothing: every figure is derived
 * from `applications`, `stage_history` and `pipeline_stages`, which is why
 * FR7.1 and FR7.2 needed no migration. FR7.3 is a different matter — it has
 * no data to derive from at all, and is recorded as an open gap rather than
 * estimated.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
