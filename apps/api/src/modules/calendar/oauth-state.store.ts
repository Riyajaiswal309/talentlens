import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CalendarProvider } from '@prisma/client';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

/** Ten minutes is ample for a consent screen and short enough to bound replay. */
const STATE_TTL_SECONDS = 600;

export interface OAuthStateClaims {
  userId: string;
  provider: CalendarProvider;
}

/**
 * The OAuth CSRF state (B).
 *
 * SERVER-SIDE, NOT A SIGNED TOKEN. D40 explicitly rejects the D5 pattern for
 * calendar consent, and this is the difference: the client receives an opaque
 * 256-bit nonce that means nothing on its own, while the binding — which user,
 * which provider — is held here. A stolen state value carries no identity and
 * cannot be forged into one, because there is nothing in it to forge.
 *
 * SINGLE USE. `consume` deletes as it reads, so a replayed callback finds
 * nothing. That is what stops an attacker re-submitting a captured
 * `?code=&state=` to bind their own calendar to someone else's account.
 *
 * Redis rather than a table: the value is short-lived and worthless once
 * spent, and `RefreshTokenStore` already establishes Redis as where this
 * project keeps expiring auth state.
 */
@Injectable()
export class OAuthStateStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OAuthStateStore.name);
  private readonly redis: Redis;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  private key(state: string): string {
    return `calendar:oauth:state:${state}`;
  }

  /**
   * Mint a state bound to the initiating user and provider.
   *
   * 32 random bytes from `randomBytes`, base64url — unguessable, and the only
   * thing the browser ever carries.
   */
  async issue(claims: OAuthStateClaims): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await this.redis.set(this.key(state), JSON.stringify(claims), 'EX', STATE_TTL_SECONDS);
    return state;
  }

  /**
   * Read and destroy in one step, or return null.
   *
   * `GETDEL` is atomic, so two concurrent callbacks with the same state cannot
   * both succeed — the second gets null. Null covers unknown, expired and
   * already-used alike, because the caller treats all three the same way and
   * distinguishing them would tell an attacker which guess was closer.
   */
  async consume(state: string): Promise<OAuthStateClaims | null> {
    if (!state) return null;

    const raw = await this.redis.getdel(this.key(state));
    if (!raw) return null;

    try {
      const claims = JSON.parse(raw) as OAuthStateClaims;
      if (!claims?.userId || !claims?.provider) return null;
      return claims;
    } catch {
      this.logger.warn('discarded an unparseable OAuth state entry');
      return null;
    }
  }
}
