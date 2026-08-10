import { ConfigService } from '@nestjs/config';
import { CalendarCredentialCipher } from './calendar-credential.cipher';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const KEY = 'calendar-encryption-key-for-tests-only';

/**
 * FR6.1 D36 / D45 — the calendar credential seal.
 *
 * A refresh token is a live grant against a third party's calendar, so these
 * tests pin the properties that make storing one defensible: it is sealed
 * before it reaches the database, it cannot be opened without the key, a
 * tampered value fails closed, and a missing key stops the service starting
 * rather than quietly downgrading to plaintext.
 */
describe('CalendarCredentialCipher (D36, D45)', () => {
  const cipher = new CalendarCredentialCipher(config({ CALENDAR_TOKEN_ENCRYPTION_KEY: KEY }));

  describe('round trip', () => {
    it('opens what it sealed', () => {
      const token = 'refresh-token-value-1//abcDEF';
      expect(cipher.open(cipher.seal(token))).toBe(token);
    });

    it('handles a long token and unicode without corruption', () => {
      const token = `${'x'.repeat(2048)}·café·🔐`;
      expect(cipher.open(cipher.seal(token))).toBe(token);
    });

    it('never emits the plaintext inside the sealed value', () => {
      const token = 'super-secret-refresh-token';
      const sealed = cipher.seal(token);

      expect(sealed).not.toContain(token);
      expect(Buffer.from(sealed, 'utf8').includes(token)).toBe(false);
    });
  });

  describe('ciphertext properties', () => {
    it('produces different ciphertext for the same plaintext each time', () => {
      const token = 'identical-refresh-token';

      const a = cipher.seal(token);
      const b = cipher.seal(token);

      /*
       * A fresh random IV per seal. Beyond GCM's requirement never to reuse a
       * nonce, this means the column cannot be used to tell whether two users
       * hold the same credential.
       */
      expect(a).not.toBe(b);
      expect(cipher.open(a)).toBe(token);
      expect(cipher.open(b)).toBe(token);
    });

    it('produces different ciphertext for different plaintexts', () => {
      expect(cipher.seal('token-a')).not.toBe(cipher.seal('token-b'));
    });
  });

  describe('a wrong or tampered value cannot be opened', () => {
    it('refuses a value sealed with a different key', () => {
      const attacker = new CalendarCredentialCipher(
        config({ CALENDAR_TOKEN_ENCRYPTION_KEY: 'a-different-key-entirely' }),
      );

      expect(cipher.open(attacker.seal('refresh-token'))).toBeNull();
    });

    it('refuses a tampered ciphertext rather than returning altered bytes', () => {
      const sealed = cipher.seal('refresh-token');
      const [iv, tag, payload] = sealed.split('.');

      // Flip the payload; GCM's tag must reject it.
      const tampered = Buffer.from(payload!, 'base64url');
      tampered[0] = tampered[0]! ^ 0xff;

      expect(cipher.open(`${iv}.${tag}.${tampered.toString('base64url')}`)).toBeNull();
    });

    it('refuses a tampered auth tag', () => {
      const [iv, tag, payload] = cipher.seal('refresh-token').split('.');
      const broken = Buffer.from(tag!, 'base64url');
      broken[0] = broken[0]! ^ 0xff;

      expect(cipher.open(`${iv}.${broken.toString('base64url')}.${payload}`)).toBeNull();
    });

    it('refuses structurally malformed values without throwing', () => {
      for (const bad of ['', '.', 'a.b', 'a.b.c.d', 'not-sealed', '..']) {
        expect(() => cipher.open(bad)).not.toThrow();
        expect(cipher.open(bad)).toBeNull();
      }
    });
  });

  describe('configuration failure is loud', () => {
    it('refuses to construct with no key', () => {
      expect(() => new CalendarCredentialCipher(config({}))).toThrow(
        /CALENDAR_TOKEN_ENCRYPTION_KEY/,
      );
    });

    it('refuses to construct with a blank key', () => {
      expect(
        () => new CalendarCredentialCipher(config({ CALENDAR_TOKEN_ENCRYPTION_KEY: '   ' })),
      ).toThrow(/CALENDAR_TOKEN_ENCRYPTION_KEY/);
    });

    it('does not silently fall back to another secret', () => {
      /*
       * Unlike D5's scheduling token, which falls back to JWT_REFRESH_SECRET
       * so a fresh checkout works, a missing key here must fail. A fallback
       * would be the silent downgrade D36 exists to prevent, and it would tie
       * a third party's credential to a secret that authenticates our own
       * callers.
       */
      expect(
        () =>
          new CalendarCredentialCipher(
            config({
              JWT_ACCESS_SECRET: 'access',
              JWT_REFRESH_SECRET: 'refresh',
              SCHEDULING_TOKEN_SECRET: 'scheduling',
            }),
          ),
      ).toThrow(/CALENDAR_TOKEN_ENCRYPTION_KEY/);
    });
  });
});
