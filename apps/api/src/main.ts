import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AuditService } from './common/audit/audit.service';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // PRD §23.1 — all endpoints versioned under /v1. /health stays at root so
  // uptime probes have a stable path across versions (PRD §25.1).
  app.setGlobalPrefix('v1', { exclude: ['health'] });

  // PRD §24.1 — the refresh token arrives as an httpOnly cookie.
  app.use(cookieParser());

  const reflector = app.get(Reflector);
  const auditService = app.get(AuditService);
  const jwtAuthGuard = app.get(JwtAuthGuard);

  /*
   * REGISTRATION ORDER IS LOAD-BEARING.
   *
   * Interceptors run in registration order: CorrelationId -> Audit.
   * AuditInterceptor stamps every record with the correlation id (NFR11), so
   * it must not run first; it throws rather than write an untraceable record.
   */
  app.useGlobalInterceptors(
    new CorrelationIdInterceptor(),
    new AuditInterceptor(reflector, auditService),
  );

  /*
   * Guards run in registration order and the order is a security property:
   *   JwtAuth  — authenticates and populates request.user (deny by default)
   *   Roles    — PRD §24.2 permission matrix, reads request.user.role
   *   Tenant   — BR-06 / R-09, reads request.user.companyId
   * Roles and Tenant have nothing to read until JwtAuth has run.
   */
  app.useGlobalGuards(jwtAuthGuard, new RolesGuard(reflector), new TenantGuard());

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
