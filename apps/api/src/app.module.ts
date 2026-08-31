import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { AiModule } from './modules/ai/ai.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuditModule } from './modules/audit/audit.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { InterviewsModule } from './modules/interviews/interviews.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { TagsModule } from './modules/tags/tags.module';
import { ScorecardsModule } from './modules/scorecards/scorecards.module';
import { HealthController } from './health/health.controller';

/**
 * Root module.
 *
 * M2.3 added the cross-cutting layer, M2.4 AuthModule, M2.6 JobsModule,
 * M2.7 ApplicationsModule, M2.8 PipelineModule and ScorecardsModule,
 * M2.9 the AiModule seam, M2.10 Admin and Audit.
 *
 * Phase 2b adds the two modules PRD §15.3 names and Handoff decision D3
 * deferred: InterviewsModule (FR6) and AnalyticsModule (FR7).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env'],
    }),
    CommonModule,
    NotificationsModule,
    AuthModule,
    JobsModule,
    ApplicationsModule,
    PipelineModule,
    TagsModule,
    ScorecardsModule,
    AiModule,
    AdminModule,
    AuditModule,
    // FR6.1 Phase 1 — calendar connection foundation. AdminModule imports it
    // directly for the FR8.4 revocation D45 requires; listed here so its
    // controller is registered.
    CalendarModule,
    // Phase 2b — FR6 and FR7, deferred out of Phase 2 by Handoff decision D3.
    InterviewsModule,
    AnalyticsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // NFR11 — applied to '*' so unmatched routes (404s) are traceable too.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
