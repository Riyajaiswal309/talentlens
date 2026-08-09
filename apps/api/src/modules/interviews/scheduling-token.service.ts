import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a valid token resolves to. Nothing else is carried. */
export interface SchedulingTokenClaims {
  interviewId: string;
  /** Unix seconds. Mirrored to the candidate as Gap 7's `expiresAt`. */
  exp: number;
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/**
 * The self-service scheduling link's credential (FR6.2, Handoff decision D5).
 *
 * D5 records the mechanism: "Signed, single-purpose, expiring token." This
 * implements that and nothing more. The token is `payload.signature`, where
 * the payload is base64url JSON of exactly the two claims above and the
 * signature is HMAC-SHA256 over the payload.
 *
 * SINGLE-PURPOSE is the security property that matters. §24.2 grants the
 * Candidate role no session-based access to interview resources, so this
 * token must not be able to stand in for one. It carries an interview id and
 * an expiry — no user id, no company id, no role — and the routes that accept
 * it read only the one interview it names (Gap 7 rule 4, BR-06). There is no
 * code path that turns it into a session.
 *
 * Signed with its own secret, never `JWT_ACCESS_SECRET`. TokenService already
 * refuses to let the access and refresh secrets be equal, for the same reason:
 * one secret across two token types means either can be replayed as the other.
 * A scheduling link is long-lived and sits in a candidate's inbox, which is
 * precisely the credential you least want interchangeable with a session.
 *
 * NOT A JWT, deliberately. `jsonwebtoken` accepts an `alg` header from the
 * token itself, and the `alg: none` and RS256→HMAC confusions are well known.
 * A fixed two-part format with one hard-coded algorithm has no negotiable
 * header to attack.
 *
 * LIFETIME IS DERIVED, NOT INVENTED. No document states a TTL, so rather than
 * picking a constant the expiry is the end of the last slot offered: after
 * that moment every choice the link could express is in the past. The caller
 * supplies it; this service only signs and checks it.
 */
@Injectable()
export class SchedulingTokenService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    /*
     * Falls back to the refresh secret when unset so a developer checkout
     * works without new configuration. Distinct from JWT_ACCESS_SECRET either
     * way, so a scheduling link can never be presented as an access token —
     * the signature simply will not verify.
     */
    this.secret =
      config.get<string>('SCHEDULING_TOKEN_SECRET') ??
      config.get<string>('JWT_REFRESH_SECRET') ??
      '';

    if (!this.secret) {
      throw new Error(
        'SCHEDULING_TOKEN_SECRET (or JWT_REFRESH_SECRET) must be set to issue ' +
          'self-service scheduling links. Generate one with: openssl rand -base64 48',
      );
    }
  }

  /** Issue a link credential for one interview, expiring at `expiresAt`. */
  sign(interviewId: string, expiresAt: Date): string {
    const claims: SchedulingTokenClaims = {
      interviewId,
      exp: Math.floor(expiresAt.getTime() / 1000),
    };
    const payload = base64url(JSON.stringify(claims));
    return `${payload}.${this.signature(payload)}`;
  }

  /**
   * Verify and decode, or return null.
   *
   * Null covers every failure — malformed, wrong signature, expired — because
   * the caller maps them all to Gap 7's `401`. Distinguishing "bad signature"
   * from "expired" in the response would tell an attacker which half of a
   * guess was right.
   */
  verify(token: string): SchedulingTokenClaims | null {
    const separator = token.lastIndexOf('.');
    if (separator <= 0) return null;

    const payload = token.slice(0, separator);
    const provided = token.slice(separator + 1);

    if (!this.signatureMatches(payload, provided)) return null;

    let claims: SchedulingTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }

    if (typeof claims?.interviewId !== 'string' || typeof claims?.exp !== 'number') {
      return null;
    }
    if (claims.exp * 1000 <= Date.now()) return null;

    return claims;
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  /**
   * Constant-time comparison.
   *
   * `timingSafeEqual` throws on a length mismatch, so the lengths are checked
   * first — and that check is safe to make in variable time, since the length
   * of an HMAC-SHA256 digest is public.
   */
  private signatureMatches(payload: string, provided: string): boolean {
    const expected = Buffer.from(this.signature(payload));
    const actual = Buffer.from(provided);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}
