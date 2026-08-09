import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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
  app.setGlobalPrefix('v1', { exclude: ['health', 'api/docs'] });

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

  /*
   * PRD §23.1 — "The OpenAPI 3.0 specification is generated from NestJS
   * decorators via @nestjs/swagger and published at /api/docs."
   *
   * Registered AFTER the global prefix so documented paths carry /v1, and
   * excluded from that prefix itself so the docs stay at /api/docs rather
   * than moving to /v1/api/docs.
   */
  const openApi = new DocumentBuilder()
    .setTitle('TalentLens API')
    .setDescription(
      'AI-Powered Recruitment & Applicant Tracking System — Phase 2. ' +
        'AI scoring is not active: getScore always returns NotScored (FR4.5).',
    )
    .setVersion('2.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addTag('admin', 'User, role, session and AI-toggle administration (FR8.1, FR8.2, FR8.4)')
    .addTag('audit', 'Append-only audit trail: browse and export (FR8.3, NFR8)')
    .build();

  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openApi), {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);

  console.log(`[api] listening on http://localhost:${port}`);
}

void bootstrap();
