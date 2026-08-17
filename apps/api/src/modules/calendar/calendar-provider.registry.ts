import { Injectable } from '@nestjs/common';
import { CalendarProvider as Provider } from '@prisma/client';
import { GoogleCalendarAdapter } from './providers/google-calendar.adapter';
import { MicrosoftCalendarAdapter } from './providers/microsoft-calendar.adapter';
import type { ProviderAdapter } from './providers/provider-adapter';

/**
 * Maps a stored `provider` value to the adapter that speaks it (D35).
 *
 * The only place that knows both providers exist. Everything above it —
 * `ConnectedCalendarProvider`, the availability endpoint, both scheduling
 * paths — deals in the enum and never in Google or Microsoft specifics.
 *
 * Adding a third provider is a new adapter plus one entry here.
 */
@Injectable()
export class CalendarProviderRegistry {
  private readonly adapters: Record<Provider, ProviderAdapter>;

  constructor(google: GoogleCalendarAdapter, microsoft: MicrosoftCalendarAdapter) {
    this.adapters = {
      [Provider.google]: google,
      [Provider.microsoft]: microsoft,
    };
  }

  get(provider: Provider): ProviderAdapter | undefined {
    return this.adapters[provider];
  }

  /** Providers this deployment actually holds client credentials for. */
  configured(): Provider[] {
    return Object.values(Provider).filter((p) => this.adapters[p].isConfigured());
  }

  /**
   * Is any provider configured at all?
   *
   * The line between "manual scheduling" (FR6.3, no integration anywhere) and
   * a deployment that has calendars and may therefore report an outage.
   */
  anyConfigured(): boolean {
    return this.configured().length > 0;
  }
}
