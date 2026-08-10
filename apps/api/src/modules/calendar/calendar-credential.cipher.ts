import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM: 12-byte nonce, 16-byte tag, both standard for this mode. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

/**
 * Seals calendar refresh tokens before they reach the database (D36 / D45).
 *
 * WHY THIS EXISTS AT ALL. §24.3 already encrypts RDS with AES-256 via KMS, so
 * it is fair to ask what a second layer buys. RDS encryption protects a stolen
 * disk or snapshot; it does nothing against anything that can *read the table*
 * — a leaked read-only credential, an over-broad support query, a backup
 * restored somewhere less careful. A refresh token is a live grant against a
 * third party's calendar, so D36 requires it sealed independently of the
 * storage layer. Ciphertext in `calendar_connections.encrypted_refresh_token`
 * is useless without a key held somewhere else entirely.
 *
 * AUTHENTICATED encryption, not merely confidential. GCM's tag means a
 * tampered ciphertext fails to open rather than decrypting to attacker-chosen
 * bytes that would then be sent to a provider as a credential.
 *
 * ITS OWN SECRET. Never `JWT_ACCESS_SECRET`, never `SCHEDULING_TOKEN_SECRET`
 * (D5). Those authenticate callers to us; this protects a credential we hold
 * on someone else's behalf, and a single compromise should not cross that
 * line. There is no fallback to another secret for the same reason: unlike the
 * scheduling link, whose fallback keeps a fresh checkout working, a missing
 * key here must be a loud failure rather than a quiet downgrade.
 */
@Injectable()
export class CalendarCredentialCipher {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const secret = config.get<string>('CALENDAR_TOKEN_ENCRYPTION_KEY');

    if (!secret || secret.trim().length === 0) {
      /*
       * FAIL CLOSED. The alternative — falling back to another secret, or
       * storing plaintext when unconfigured — is exactly the silent downgrade
       * D36 forbids. A deployment without this key must not be able to accept
       * a calendar connection at all.
       */
      throw new Error(
        'CALENDAR_TOKEN_ENCRYPTION_KEY must be set to store calendar credentials (D36/D45). ' +
          'Generate one with: openssl rand -base64 32',
      );
    }

    /*
     * SHA-256 of the configured secret, so any length of input yields the
     * 32 bytes AES-256 needs. This is key derivation for a high-entropy
     * secret, not password hashing — the operator is instructed to supply
     * `openssl rand -base64 32`, so there is no low-entropy input for a slow
     * KDF to defend.
     */
    this.key = createHash('sha256').update(secret).digest();
  }

  /**
   * Seal a refresh token.
   *
   * Returns `iv.tag.ciphertext`, base64url, so the stored value is one opaque
   * string with everything needed to open it except the key.
   *
   * A FRESH RANDOM IV EVERY TIME. Reusing a nonce under the same key breaks
   * GCM catastrophically, and it also means sealing the same token twice
   * produces different ciphertext — so the column cannot be used to tell
   * whether two users hold the same credential.
   */
  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [iv.toString('base64url'), tag.toString('base64url'), sealed.toString('base64url')].join(
      '.',
    );
  }

  /**
   * Open a sealed token, or return null.
   *
   * Null for every failure — malformed, wrong key, tampered — because a caller
   * can do only one thing about any of them: treat the connection as unusable
   * and move it to `disconnected` (D36). Distinguishing the causes would give
   * an attacker a decryption oracle and give callers a choice they should not
   * be making.
   *
   * CALL THIS ONLY INSIDE THE PROVIDER BOUNDARY. The plaintext is a live grant
   * on a third party's calendar; it must never be logged, returned from an
   * endpoint, or placed in audit state.
   */
  open(sealed: string): string | null {
    const parts = sealed.split('.');
    if (parts.length !== 3) return null;

    const [ivPart, tagPart, cipherPart] = parts;

    try {
      const iv = Buffer.from(ivPart!, 'base64url');
      const tag = Buffer.from(tagPart!, 'base64url');
      const payload = Buffer.from(cipherPart!, 'base64url');

      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);

      return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
    } catch {
      // `final()` throws when the tag does not verify. That is the expected
      // path for a wrong key or a tampered value, not an exceptional one.
      return null;
    }
  }
}
