import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

/**
 * Liveness probe.
 *
 * PRD §25.1 requires uptime monitoring against /health. This is the minimum
 * viable version: it reports that the process is up. Dependency checks
 * (Postgres, Redis) are added in M2.2 once those connections exist.
 *
 * Served at the root, outside the `/v1` prefix (main.ts `exclude`), so uptime
 * probes keep a stable path across API versions.
 */
@Controller('health')
export class HealthController {
  /**
   * @Public() because the caller is a machine with no account.
   *
   * PRD §7 monitors platform uptime with "Route 53 health checks against
   * `/health`", and §25.1 Table 25.1 alerts on "2 consecutive `/health`
   * failures". An external probe cannot present a bearer token, so under the
   * deny-by-default rule this route answered 401 to every check — meaning the
   * uptime alert would fire permanently while the service was perfectly
   * healthy, and a load balancer would drain a working instance.
   *
   * Nothing is weakened by opting out here: the response is three constants
   * and a timestamp. It reads no request, touches no database, and names no
   * tenant, user or version — so an anonymous caller learns only that the
   * process is running, which is exactly what a liveness probe is for.
   */
  @Get()
  @Public()
  check(): { status: string; service: string; timestamp: string } {
    return {
      status: 'ok',
      service: 'talentlens-api',
      timestamp: new Date().toISOString(),
    };
  }
}
