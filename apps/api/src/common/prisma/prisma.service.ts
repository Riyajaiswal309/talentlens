import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

/**
 * Database access for the application.
 *
 * Connects as APP_DATABASE_URL — the RESTRICTED role created in M2.2, not the
 * schema owner. This matters: PRD §17.3 requires audit_logs to be append-only,
 * and a table owner bypasses REVOKE in PostgreSQL. Connecting as the owner
 * would silently disable that guarantee.
 *
 * Migrations continue to run as the owner (DATABASE_URL) via the Prisma CLI.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const appUrl = config.get<string>('APP_DATABASE_URL');
    const ownerUrl = config.get<string>('DATABASE_URL');

    super({ datasourceUrl: appUrl ?? ownerUrl });

    if (!appUrl) {
      // Loud, because the audit guarantee depends on it.
      new Logger(PrismaService.name).warn(
        'APP_DATABASE_URL is not set; falling back to DATABASE_URL. ' +
          'If that is the owner role, audit_logs append-only enforcement (PRD §17.3) is NOT active.',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
