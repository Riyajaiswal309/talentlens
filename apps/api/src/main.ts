import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { AuditService } from './common/audit/audit.service';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // PRD §23.1 — all endpoints versioned under /v1. /health stays at root so
  // uptime probes have a stable path across versions (PRD §25.1).
  app.setGlobalPrefix('v1', { exclude: ['health'] });

  const reflector = app.get(Reflector);
  const auditService = app.get(AuditService);

  /*
   * REGISTRATION ORDER IS LOAD-BEARING.
   *
   * Interceptors run in registration order on the way in:
   *   CorrelationId -> Audit
   * AuditInterceptor stamps every record with the correlation id (NFR11), so
   * it must not run first. It throws if the id is missing rather than writing
   * an untraceable record.
   */
  app.useGlobalInterceptors(
    new CorrelationIdInterceptor(),
    new AuditInterceptor(reflector, auditService),
  );

  /*
   * Guards: role first, then tenant. Both applied globally so a new module
   * cannot silently opt out — the R-09 mitigation (PRD §28).
   */
  app.useGlobalGuards(new RolesGuard(reflector), new TenantGuard(reflector));

  // PRD §23.1 — reject any body that does not strictly match its DTO.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // RFC 7807 problem+json for every error (PRD §23.1).
  app.useGlobalFilters(new ProblemDetailsFilter());

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);

  console.log(`[api] listening on http://localhost:${port}`);
}

void bootstrap();
