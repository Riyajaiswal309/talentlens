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
import { CandidateOwnershipGuard } from './common/guards/candidate-ownership.guard';
import { JobAssignmentGuard } from './common/guards/job-assignment.guard';
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
  const jobAssignmentGuard = app.get(JobAssignmentGuard);
  const candidateOwnershipGuard = app.get(CandidateOwnershipGuard);

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
   *   JwtAuth          — authenticates, populates request.user (deny by default)
   *   Roles            — PRD §24.2 permission matrix (role -> action)
   *   Tenant           — BR-06 / R-09, asserts the caller has a tenant
   *   JobAssignment    — §24.2 HM "assigned jobs only"; also proves the job
   *                      belongs to the caller's tenant
   *   CandidateOwnership — BR-06, one candidate cannot reach another's data
   *
   * Cheap checks precede database lookups, so an unauthorised request is
   * rejected before it can cost a query. The two row-level guards run last
   * because they need both a principal and a validated role.
   */
  app.useGlobalGuards(
    jwtAuthGuard,
    new RolesGuard(reflector),
    new TenantGuard(),
    jobAssignmentGuard,
    candidateOwnershipGuard,
  );

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
