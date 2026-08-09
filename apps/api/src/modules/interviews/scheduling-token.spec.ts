import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ManualCalendarProvider } from './calendar.provider';
import { SchedulingTokenService } from './scheduling-token.service';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const SECRETS = {
  SCHEDULING_TOKEN_SECRET: 'scheduling-secret-for-tests-only',
  JWT_ACCESS_SECRET: 'access-secret-for-tests-only',
  JWT_REFRESH_SECRET: 'refresh-secret-for-tests-only',
};

/**
 * The scheduling link's credential (FR6.2, Handoff decision D5).
 *
 * These are unit checks on the properties D5 names — signed, single-purpose,
 * expiring — kept separate from the HTTP spec so a failure points at the
 * token rather than at a route.
 */
describe('SchedulingTokenService (D5)', () => {
  const service = new SchedulingTokenService(config(SECRETS));
  const future = () => new Date(Date.now() + 86_400_000);

  describe('round trip', () => {
    it('verifies a token it issued and returns the interview id', () => {
      const id = randomUUID();
      const claims = service.verify(service.sign(id, future()));

      expect(claims?.interviewId).toBe(id);
    });

    it('carries the interview id and expiry, and nothing else', () => {
      const token = service.sign(randomUUID(), future());
      const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));

      // No user id, company id or role — the token cannot stand in for a
      // session because it does not describe a principal (§24.2).
      expect(Object.keys(payload).sort()).toEqual(['exp', 'interviewId']);
    });
  });

  describe('signature', () => {
    it('rejects a payload swapped for another interview', () => {
      const token = service.sign(randomUUID(), future());
      const signature = token.split('.')[1]!;
      const forged = Buffer.from(
        JSON.stringify({ interviewId: randomUUID(), exp: 4_102_444_800 }),
      ).toString('base64url');

      expect(service.verify(`${forged}.${signature}`)).toBeNull();
    });

    it('rejects a token signed with a different secret', () => {
      const attacker = new SchedulingTokenService(
        config({ ...SECRETS, SCHEDULING_TOKEN_SECRET: 'not-the-real-secret' }),
      );

      expect(service.verify(attacker.sign(randomUUID(), future()))).toBeNull();
    });

    it('rejects an unsigned token', () => {
      const payload = Buffer.from(
        JSON.stringify({ interviewId: randomUUID(), exp: 4_102_444_800 }),
      ).toString('base64url');

      expect(service.verify(payload)).toBeNull();
      expect(service.verify(`${payload}.`)).toBeNull();
    });

    it('rejects a truncated signature rather than throwing', () => {
      const token = service.sign(randomUUID(), future());
      const [payload, signature] = token.split('.');

      // timingSafeEqual throws on a length mismatch; the length guard must
      // catch this before it reaches there.
      expect(() => service.verify(`${payload}.${signature!.slice(0, 10)}`)).not.toThrow();
      expect(service.verify(`${payload}.${signature!.slice(0, 10)}`)).toBeNull();
    });

    it('rejects garbage', () => {
      for (const bad of ['', '.', 'x', 'a.b', 'not-a-token', '..']) {
        expect(service.verify(bad)).toBeNull();
      }
    });
  });

  describe('expiry', () => {
    it('rejects a token past its expiry', () => {
      expect(service.verify(service.sign(randomUUID(), new Date(Date.now() - 1)))).toBeNull();
    });

    it('accepts one that has not expired yet', () => {
      expect(
        service.verify(service.sign(randomUUID(), new Date(Date.now() + 60_000))),
      ).not.toBeNull();
    });
  });

  describe('secret separation', () => {
    it('never signs with JWT_ACCESS_SECRET', () => {
      /*
       * A scheduling link sits in an inbox for days. If it were signed with
       * the access-token secret, anything that accepts an access token would
       * have to be trusted not to accept this instead.
       */
      const signedWithAccess = new SchedulingTokenService(
        config({ ...SECRETS, SCHEDULING_TOKEN_SECRET: SECRETS.JWT_ACCESS_SECRET }),
      );
      const real = new SchedulingTokenService(config(SECRETS));
      const id = randomUUID();
      const expiry = future();

      expect(real.sign(id, expiry)).not.toBe(signedWithAccess.sign(id, expiry));
    });

    it('falls back to the refresh secret, not the access secret, when unconfigured', () => {
      const fallback = new SchedulingTokenService(
        config({ ...SECRETS, SCHEDULING_TOKEN_SECRET: undefined }),
      );
      const refresh = new SchedulingTokenService(
        config({ ...SECRETS, SCHEDULING_TOKEN_SECRET: SECRETS.JWT_REFRESH_SECRET }),
      );
      const id = randomUUID();
      const expiry = future();

      expect(fallback.sign(id, expiry)).toBe(refresh.sign(id, expiry));
    });

    it('refuses to start with no secret at all', () => {
      expect(
        () =>
          new SchedulingTokenService(
            config({ SCHEDULING_TOKEN_SECRET: undefined, JWT_REFRESH_SECRET: undefined }),
          ),
      ).toThrow(/SCHEDULING_TOKEN_SECRET/);
    });
  });
});

/**
 * FR6.3 — the default calendar binding.
 *
 * The available/no-event combination is the whole of graceful degradation,
 * and getting it backwards would make every self-service confirmation return
 * 503 on a deployment with no calendar integration.
 */
describe('ManualCalendarProvider (FR6.3)', () => {
  const provider = new ManualCalendarProvider();

  it('reports itself available so the workflow completes', () => {
    expect(provider.isAvailable()).toBe(true);
  });

  it('creates no event, leaving calendar_event_id null', async () => {
    const event = await provider.createEvent({
      jobTitle: 'Backend Engineer',
      candidateName: 'A Candidate',
      startsAt: new Date(),
      endsAt: new Date(),
      timezone: 'Europe/London',
      interviewerEmails: [],
    });

    expect(event).toBeNull();
  });
});
