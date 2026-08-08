import { Controller, Get } from '@nestjs/common';

/**
 * Liveness probe.
 *
 * PRD §25.1 requires uptime monitoring against /health. This is the minimum
 * viable version: it reports that the process is up. Dependency checks
 * (Postgres, Redis) are added in M2.2 once those connections exist.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; service: string; timestamp: string } {
    return {
      status: 'ok',
      service: 'talentlens-api',
      timestamp: new Date().toISOString(),
    };
  }
}
