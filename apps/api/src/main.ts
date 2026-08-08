import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Core API bootstrap.
 *
 * M2.1 scope: process starts and serves /health only.
 * Guards, interceptors, validation pipe and the RFC 7807 filter land in M2.3;
 * they are deliberately absent here rather than stubbed.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // PRD §23.1 — all endpoints are versioned under /v1.
  app.setGlobalPrefix('v1', { exclude: ['health'] });

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);

  console.log(`[api] listening on http://localhost:${port}`);
}

void bootstrap();
