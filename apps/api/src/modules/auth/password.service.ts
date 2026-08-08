import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/** PRD §24.1 — minimum 12 characters. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Argon2id password hashing (PRD §24.1).
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet baseline for
 * Argon2id (PRD §24.4 commits to OWASP guidance): 19 MiB memory, 2 passes,
 * 1 degree of parallelism.
 */
@Injectable()
export class PasswordService {
  private readonly options = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456, // KiB
    timeCost: 2,
    parallelism: 1,
  };

  /**
   * A hash of a value nobody can present, used to spend the same CPU time on
   * a missing user as on a real one. Without it, "unknown email" would return
   * measurably faster than "wrong password" and leak which emails exist.
   */
  private dummyHash: string | null = null;

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, this.options);
  }

  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext, this.options);
    } catch {
      // A malformed or truncated hash must read as "wrong password", never
      // as a 500 that tells an attacker the record is unusual.
      return false;
    }
  }

  /** Burn equivalent time when no user matched, to blunt user enumeration. */
  async verifyDummy(plaintext: string): Promise<void> {
    this.dummyHash ??= await this.hash('argon2id-timing-equaliser');
    await this.verify(this.dummyHash, plaintext);
  }
}
