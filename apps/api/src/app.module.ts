import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { HealthController } from './health/health.controller';

/**
 * Root module.
 *
 * M2.3 adds the cross-cutting layer (CommonModule). Feature modules — Auth,
 * Jobs, Applications, Pipeline, Scorecards, Admin, Audit, Notifications, Ai —
 * arrive from M2.4 onward in the Handoff Part 3 order. None exist yet.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env'],
    }),
    CommonModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // NFR11 — applied to '*' so unmatched routes (404s) are traceable too.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
