import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { GoogleCalendarAdapter, eventTitle } from './google-calendar.adapter';
import { MicrosoftCalendarAdapter } from './microsoft-calendar.adapter';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const GOOGLE = {
  GOOGLE_CALENDAR_CLIENT_ID: 'google-client-id',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'google-secret',
  GOOGLE_CALENDAR_REDIRECT_URI: 'https://app.example/settings/calendar/google',
};
const MICROSOFT = {
  MICROSOFT_CALENDAR_CLIENT_ID: 'ms-client-id',
  MICROSOFT_CALENDAR_CLIENT_SECRET: 'ms-secret',
  MICROSOFT_CALENDAR_REDIRECT_URI: 'https://app.example/settings/calendar/microsoft',
};

/**
 * The provider adapters (D35).
 *
 * WHAT IS AND IS NOT TESTED HERE. Token exchange, refresh, free/busy and event
 * creation all require live client credentials and a real provider, so they
 * cannot be exercised in this suite — and a recorded fixture would only prove
 * the fixture was replayed. Those paths are reported as not live-verified.
 *
 * What IS verifiable without a provider is everything that decides whether a
 * request is ever made and what it asks for: configuration gating, the
 * authorization URL, the scopes requested, and the event title. The scopes in
 * particular are worth pinning — they decide how much of an employee's
 * calendar this system can read.
 */
describe('Calendar provider adapters (FR6.1, D35)', () => {
  describe('configuration gating', () => {
    it('Google reports unconfigured when any credential is missing', () => {
      expect(new GoogleCalendarAdapter(config({})).isConfigured()).toBe(false);
      expect(
        new GoogleCalendarAdapter(
          config({ ...GOOGLE, GOOGLE_CALENDAR_CLIENT_SECRET: '' }),
        ).isConfigured(),
      ).toBe(false);
      expect(new GoogleCalendarAdapter(config(GOOGLE)).isConfigured()).toBe(true);
    });

    it('Microsoft reports unconfigured when any credential is missing', () => {
      expect(new MicrosoftCalendarAdapter(config({})).isConfigured()).toBe(false);
      expect(
        new MicrosoftCalendarAdapter(
          config({ ...MICROSOFT, MICROSOFT_CALENDAR_REDIRECT_URI: '' }),
        ).isConfigured(),
      ).toBe(false);
      expect(new MicrosoftCalendarAdapter(config(MICROSOFT)).isConfigured()).toBe(true);
    });

    it('neither adapter throws when unconfigured — absent is not broken', () => {
      // An unconfigured provider must construct cleanly, because the registry
      // asks every adapter whether it is configured on every request.
      expect(() => new GoogleCalendarAdapter(config({}))).not.toThrow();
      expect(() => new MicrosoftCalendarAdapter(config({}))).not.toThrow();
    });
  });

  describe('Google authorization URL', () => {
    const adapter = new GoogleCalendarAdapter(config(GOOGLE));

    it('carries the state, the client and the redirect', () => {
      const url = new URL(adapter.authorizationUrl('state-abc'));

      expect(url.origin + url.pathname).toContain('accounts.google.com');
      expect(url.searchParams.get('state')).toBe('state-abc');
      expect(url.searchParams.get('client_id')).toBe(GOOGLE.GOOGLE_CALENDAR_CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(GOOGLE.GOOGLE_CALENDAR_REDIRECT_URI);
    });

    it('requests offline access and forces consent, so a refresh token is issued', () => {
      const url = new URL(adapter.authorizationUrl('s'));

      // Without both of these a re-connect can silently yield no refresh
      // token, producing a connection that is dead on arrival.
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
    });

    it('requests free/busy and event scopes only — never full calendar read', () => {
      const scope = new URL(adapter.authorizationUrl('s')).searchParams.get('scope') ?? '';

      expect(scope).toContain('calendar.freebusy');
      expect(scope).toContain('calendar.events');
      expect(scope).toContain('userinfo.email');
      // The broad scope would let this system read every event on an
      // employee's calendar, which FR6.1 never asks for.
      expect(scope).not.toMatch(/auth\/calendar(\s|$)/);
      expect(scope).not.toContain('calendar.readonly');
    });

    it('never puts the client secret in the URL', () => {
      expect(adapter.authorizationUrl('s')).not.toContain(GOOGLE.GOOGLE_CALENDAR_CLIENT_SECRET);
    });
  });

  describe('Microsoft authorization URL', () => {
    const adapter = new MicrosoftCalendarAdapter(config(MICROSOFT));

    it('carries the state, the client and the redirect', () => {
      const url = new URL(adapter.authorizationUrl('state-xyz'));

      expect(url.origin).toBe('https://login.microsoftonline.com');
      expect(url.searchParams.get('state')).toBe('state-xyz');
      expect(url.searchParams.get('client_id')).toBe(MICROSOFT.MICROSOFT_CALENDAR_CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(MICROSOFT.MICROSOFT_CALENDAR_REDIRECT_URI);
      expect(url.searchParams.get('response_type')).toBe('code');
    });

    it('requests offline_access so a refresh token is issued', () => {
      const scope = new URL(adapter.authorizationUrl('s')).searchParams.get('scope') ?? '';

      expect(scope).toContain('offline_access');
      expect(scope).toContain('Calendars.ReadWrite');
      expect(scope).toContain('User.Read');
    });

    it('defaults to the common authority and honours a configured tenant', () => {
      expect(adapter.authorizationUrl('s')).toContain('/common/');

      const single = new MicrosoftCalendarAdapter(
        config({ ...MICROSOFT, MICROSOFT_CALENDAR_TENANT: 'tenant-guid' }),
      );
      expect(single.authorizationUrl('s')).toContain('/tenant-guid/');
    });

    it('never puts the client secret in the URL', () => {
      expect(adapter.authorizationUrl('s')).not.toContain(
        MICROSOFT.MICROSOFT_CALENDAR_CLIENT_SECRET,
      );
    });
  });

  describe('event title (D41)', () => {
    it('is derived from job title and candidate name, and nothing else', () => {
      const title = eventTitle({
        jobTitle: 'Backend Engineer',
        candidateName: 'Jordan Ali',
        startsAt: new Date(),
        endsAt: new Date(),
        timezone: 'Europe/London',
        interviewerEmails: ['a@x.test'],
        interviewerUserIds: ['u1'],
      });

      expect(title).toBe('Interview: Backend Engineer — Jordan Ali');
      // No description, location or conferencing is specified for v1, and the
      // title must not become a place to smuggle them in.
      expect(title).not.toContain('@');
    });

    it('is shared by both adapters, so the event reads the same either way', () => {
      // D35 — a candidate or interviewer must not be able to tell which
      // provider a colleague uses from the event itself.
      const google = readFileSync(`${__dirname}/google-calendar.adapter.ts`, 'utf8');
      const microsoft = readFileSync(`${__dirname}/microsoft-calendar.adapter.ts`, 'utf8');

      expect(google).toContain('export function eventTitle');
      expect(microsoft).toContain("import { eventTitle } from './google-calendar.adapter'");
    });
  });
});
