import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { HealthController } from './health.controller';
import { AuditService } from '../common/audit/audit.service';
import { CommonModule } from '../common/common.module';
import { ProblemDetailsFilter } from '../common/filters/problem-details.filter';
import { CandidateOwnershipGuard } from '../common/guards/candidate-ownership.guard';
import { JobAssignmentGuard } from '../common/guards/job-assignment.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { AuditInterceptor } from '../common/interceptors/audit.interceptor';
import { CorrelationIdInterceptor } from '../common/interceptors/correlation-id.interceptor';
import { CorrelationIdMiddleware } from '../common/middleware/correlation-id.middleware';
import { AuthModule } from '../modules/auth/auth.module';
import { JwtAuthGuard } from '../modules/auth/guards/jwt-auth.guard';
import { JobsModule } from '../modules/jobs/jobs.module';
import type { NextFunction, Response } from 'express';
import type { RequestContext } from '../common/types/authenticated-request';

/**
 * `/health` must answer an unauthenticated probe (PRD §7, §25.1).
 *
 * The existing `health.controller.spec.ts` calls the controller method
 * directly, which is why it kept passing while every real request to
 * `/health` returned 401: a unit call never meets the global JwtAuthGuard.
 * This suite boots the guard stack exactly as `main.ts` does — including the
 * `/v1` prefix and its `health` exclusion — so the regression it guards
 * against is the one that actually happened.
 *
 * A protected route is mounted alongside it, because "health is reachable" is
 * only half the requirement; the other half is that opening it changed
 * nothing else.
 */
describe('GET /health authentication (PRD §7, §25.1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
        CommonModule,
        AuthModule,
        // A module of ordinary protected routes, to prove deny-by-default
        // still holds for everything that is not the probe.
        JobsModule,
      ],
      controllers: [HealthController],
    }).compile();

    app = moduleRef.createNestApplication();

    // Mirrors main.ts: /health is deliberately outside the version prefix so
    // uptime probes keep one path across API versions.
    app.setGlobalPrefix('v1', { exclude: ['health', 'api/docs'] });

    app.use((req: RequestContext, res: Response, next: NextFunction) =>
      new CorrelationIdMiddleware().use(req, res, next),
    );

    const reflector = app.get(Reflector);
    app.useGlobalInterceptors(
      new CorrelationIdInterceptor(),
      new AuditInterceptor(reflector, app.get(AuditService)),
    );
    app.useGlobalGuards(
      app.get(JwtAuthGuard),
      new RolesGuard(reflector),
      new TenantGuard(),
      app.get(JobAssignmentGuard),
      app.get(CandidateOwnershipGuard),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('the probe is reachable', () => {
    it('returns 200 with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('is served at the root, not under /v1', async () => {
      // The exclusion in main.ts is deliberate (a stable path across
      // versions), so the versioned path must NOT answer.
      await request(app.getHttpServer()).get('/v1/health').expect(404);
    });

    it('ignores a malformed Authorization header rather than rejecting', async () => {
      // A probe that sends junk, or a proxy that injects a stale header,
      // must not be able to take the health check down.
      await request(app.getHttpServer())
        .get('/health')
        .set({ Authorization: 'Bearer not-a-real-token' })
        .expect(200);
    });
  });

  describe('the response contract is unchanged', () => {
    it('returns exactly status, service and timestamp', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);

      expect(Object.keys(response.body).sort()).toEqual(['service', 'status', 'timestamp']);
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('talentlens-api');
      expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
    });

    it('discloses nothing about the deployment to an anonymous caller', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);
      const body = JSON.stringify(response.body).toLowerCase();

      // No version, tenant, user, database or dependency detail — a liveness
      // probe reports that the process is up and nothing else.
      for (const leak of [
        'version',
        'company',
        'tenant',
        'user',
        'database',
        'postgres',
        'redis',
      ]) {
        expect(body).not.toContain(leak);
      }
    });
  });

  describe('nothing else was opened', () => {
    it('a protected route still returns 401 without a token', async () => {
      await request(app.getHttpServer()).get('/v1/jobs').expect(401);
    });

    it('a protected route still returns 401 with an invalid token', async () => {
      await request(app.getHttpServer())
        .get('/v1/jobs')
        .set({ Authorization: 'Bearer not-a-real-token' })
        .expect(401);
    });

    /**
     * A source-tree guard, in the manner of audit.spec.ts's vocabulary check.
     *
     * Adding @Public() is the one edit in this codebase that can silently
     * remove authentication from a route, and a reviewer cannot see the whole
     * blast radius from a diff. This pins the complete set: every file that
     * carries the marker, and why it is allowed to.
     *
     * If this fails, a route was opened. Confirm it belongs on the list below
     * before changing the expectation.
     */
    it('only the intended files carry @Public()', () => {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((entry) => {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) return walk(full);
          return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
        });

      const src = join(__dirname, '..');
      /*
       * Comments are stripped before scanning. A file that only DISCUSSES
       * `@Public()` in a docblock — several now explain why they must not use
       * it — is not a file that opened a route, and flagging it would train
       * the next reader to ignore this test.
       */
      const withoutComments = (source: string) =>
        source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      const marked = walk(src)
        .filter((file) => /@Public\(\)/.test(withoutComments(readFileSync(file, 'utf8'))))
        .map((file) =>
          file
            .slice(src.length + 1)
            .split(sep)
            .join('/'),
        )
        .sort();

      /*
       * Files that APPLY the decorator. `public.decorator.ts` and
       * `jwt-auth.guard.ts` define and read it but never apply it, so with
       * comments stripped they correctly drop out — leaving exactly the five
       * surfaces that are genuinely unauthenticated.
       *
       * The calendar module is deliberately absent (FR6.1, D40): its OAuth
       * routes run under the interviewer's own session.
       */
      expect(marked).toEqual([
        'health/health.controller.ts', // liveness probe, PRD §7 / §25.1
        'modules/applications/applications.controller.ts', // FR2.1 public submission
        'modules/auth/auth.controller.ts', // login / refresh
        'modules/interviews/scheduling.controller.ts', // FR6.2 token-authenticated
        'modules/jobs/public-jobs.controller.ts', // CA-01 public job board
      ]);
    });
  });
});
