import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { AuthModule } from './modules/auth/auth.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { HealthController } from './health/health.controller';

/**
 * Root module.
 *
 * M2.3 added the cross-cutting layer, M2.4 AuthModule, M2.6 JobsModule.
 * Remaining feature modules — Applications, Pipeline, Scorecards, Admin,
 * Audit, Notifications, Ai — arrive from M2.7 in the Handoff Part 3 order.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env'],
    }),
    CommonModule,
    AuthModule,
    JobsModule,
    ApplicationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // NFR11 — applied to '*' so unmatched routes (404s) are traceable too.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
