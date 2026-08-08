import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';

/**
 * Root module.
 *
 * Feature modules (Auth, Jobs, Applications, Pipeline, Scorecards, Admin,
 * Audit, Notifications, Ai) are introduced from M2.3 onward in the order set
 * out in the Phase 1 → Phase 2 Handoff, Part 3. None exist yet.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env'],
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
