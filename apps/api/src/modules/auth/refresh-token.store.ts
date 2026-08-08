import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Refresh-token registry backed by Redis (PRD §16 — "Session cache").
 *
 * PRD §24.1 requires:
 *   - rotation: "the previous token is invalidated on use"
 *   - reuse detection: "a replayed stolen token is detectable"
 *   - FR8.4: all of a user's tokens revocable immediately
 *
 * A stateless JWT alone cannot satisfy any of those — nothing can be
 * invalidated before it expires. So each issued refresh token's `jti` is
 * registered here, and a token is only honoured if its jti is still present.
 *
 * Two key shapes:
 *   refresh:{userId}:{jti} -> "1"   one per live token, TTL = token lifetime
 *   refresh:{userId}                a SET of that user's live jtis, so FR8.4
 *                                   revocation is one lookup plus a delete
 */
@Injectable()
export class RefreshTokenStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefreshTokenStore.name);
  private readonly redis: Redis;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect();
    this.logger.log('Redis connected (refresh-token store)');
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  private key(userId: string, jti: string): string {
    return `refresh:${userId}:${jti}`;
  }

  private setKey(userId: string): string {
    return `refresh:${userId}`;
  }

  /** Register a newly issued refresh token. */
  async register(userId: string, jti: string, ttlSeconds: number): Promise<void> {
    await this.redis
      .multi()
      .set(this.key(userId, jti), '1', 'EX', ttlSeconds)
      .sadd(this.setKey(userId), jti)
      .expire(this.setKey(userId), ttlSeconds)
      .exec();
  }

  /**
   * Atomically consume a token.
   *
   * Returns true only if the jti was live at this instant. DEL returns the
   * number of keys removed, so two concurrent refreshes with the same token
   * cannot both succeed — exactly one gets 1, the other 0. Checking existence
   * and then deleting would leave that race open.
   */
  async consume(userId: string, jti: string): Promise<boolean> {
    const removed = await this.redis.del(this.key(userId, jti));
    await this.redis.srem(this.setKey(userId), jti);
    return removed === 1;
  }

  /**
   * FR8.4 — revoke every live refresh token for a user. Returns how many were
   * revoked so the admin panel can report it.
   */
  async revokeAll(userId: string): Promise<number> {
    const jtis = await this.redis.smembers(this.setKey(userId));
    if (jtis.length === 0) {
      await this.redis.del(this.setKey(userId));
      return 0;
    }

    const keys = jtis.map((jti) => this.key(userId, jti));
    await this.redis.del(...keys, this.setKey(userId));
    return jtis.length;
  }

  /** Number of live refresh tokens for a user (used by tests and admin views). */
  async countLive(userId: string): Promise<number> {
    return this.redis.scard(this.setKey(userId));
  }
}
