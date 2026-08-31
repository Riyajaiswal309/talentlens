import { useState } from 'react';
import { Badge, Card, CardHeader, Notice, PageHeader, buttonClass } from '../../components/ui';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonText } from '../../components/Skeleton';
import {
  CALENDAR_PROVIDERS,
  PROVIDER_LABELS,
  liveConnectionFor,
  useBeginCalendarConnect,
  useCalendarConnections,
  useCalendarProviders,
  useDisconnectCalendar,
  type CalendarProviderId,
} from './useCalendarConnections';

/**
 * FR6.1 — connect your own calendar.
 *
 * WHAT THIS SCREEN WILL NOT DO. It never reports a calendar as connected unless
 * `GET /v1/calendar/connections` says so, it never invents availability, and it
 * offers no Connect button for a provider this deployment holds no credentials
 * for — that button could only produce a 503. Whether a provider is configured
 * is read from the server, not guessed from a failed attempt.
 *
 * ONE'S OWN CALENDAR ONLY (D34, D44). There is no route that lists or connects
 * another user's calendar, so there is nothing here for an administrator to
 * manage on someone else's behalf; the Admin force-disconnect is a separate
 * endpoint and deliberately has no screen.
 */
export function CalendarConnectionsPage() {
  const providers = useCalendarProviders();
  const connections = useCalendarConnections();
  const begin = useBeginCalendarConnect();
  const disconnect = useDisconnectCalendar();

  const [pending, setPending] = useState<CalendarProviderId | null>(null);

  const isConfigured = (provider: string) =>
    providers.data?.find((p) => p.provider === provider)?.configured ?? false;

  const anyConfigured = providers.data?.some((p) => p.configured) ?? false;

  async function connect(provider: CalendarProviderId) {
    setPending(provider);
    try {
      const { authorizationUrl } = await begin.mutateAsync(provider);
      /*
       * A full navigation, not a popup. The provider redirects back to
       * `/settings/calendar/callback`, which re-enters this session and posts
       * `code` and `state` to `/complete`. A popup would work too, but it adds
       * cross-window messaging for no gain here.
       */
      window.location.assign(authorizationUrl);
    } catch {
      // The mutation's own error state renders below; nothing to add.
      setPending(null);
    }
  }

  if (providers.isPending || connections.isPending) {
    return (
      <div>
        <PageHeader code="FR6.1" title="Calendar connections" />
        <LoadingState label="Loading calendar connections…">
          <Card>
            <div className="p-5">
              <SkeletonText lines={3} />
            </div>
          </Card>
        </LoadingState>
      </div>
    );
  }

  if (providers.isError || connections.isError) {
    return (
      <div>
        <PageHeader code="FR6.1" title="Calendar connections" />
        <ErrorState
          error={providers.error ?? connections.error}
          title="Calendar connections could not be loaded"
          onRetry={() => {
            void providers.refetch();
            void connections.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        code="FR6.1"
        title="Calendar connections"
        description="Connect your own calendar so your free/busy times can be read when an interview is being arranged."
      />

      {/*
        Said once, at the top, when the deployment has no provider at all —
        otherwise the same sentence would repeat on every card.
      */}
      {!anyConfigured && (
        <div className="mb-5">
          <Notice tone="info" title="No calendar provider is configured on this server">
            <p>
              Neither Google nor Microsoft credentials are present in this deployment, so no
              calendar can be connected here. Interview scheduling still works — times are entered
              by hand, and interviewers are reported as having no calendar data rather than being
              shown as free.
            </p>
          </Notice>
        </div>
      )}

      <div className="space-y-4">
        {CALENDAR_PROVIDERS.map((provider) => (
          <ProviderCard
            key={provider}
            provider={provider}
            configured={isConfigured(provider)}
            connection={liveConnectionFor(connections.data, provider)}
            connecting={pending === provider && begin.isPending}
            disconnecting={disconnect.isPending && disconnect.variables === provider}
            onConnect={() => void connect(provider)}
            onDisconnect={() => disconnect.mutate(provider)}
          />
        ))}
      </div>

      {begin.isError && (
        <div className="mt-4">
          <ErrorState error={begin.error} title="The connection could not be started" />
        </div>
      )}
      {disconnect.isError && (
        <div className="mt-4">
          <ErrorState error={disconnect.error} title="The calendar could not be disconnected" />
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  configured,
  connection,
  connecting,
  disconnecting,
  onConnect,
  onDisconnect,
}: {
  provider: CalendarProviderId;
  configured: boolean;
  connection: { accountIdentifier: string; createdAt: string } | undefined;
  connecting: boolean;
  disconnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const label = PROVIDER_LABELS[provider];

  return (
    <Card>
      <CardHeader
        title={label}
        action={
          connection ? (
            <Badge tone="success">Connected</Badge>
          ) : configured ? (
            <Badge tone="neutral">Not connected</Badge>
          ) : (
            <Badge tone="neutral">Unavailable</Badge>
          )
        }
      />
      <div className="p-5">
        {!configured ? (
          /*
            The exact honest sentence. No Connect button: `authorize` would
            answer 503, and offering a control that cannot succeed is worse
            than explaining why it is absent.
          */
          <>
            <p className="text-sm text-neutral-700">{label} is not configured on this server.</p>
            <p className="mt-1.5 max-w-[70ch] text-sm text-neutral-500">
              The integration is built, but this deployment holds no {label} client credentials, so
              the consent flow cannot start. An administrator would need to register an application
              with the provider and supply its credentials.
            </p>
          </>
        ) : connection ? (
          <>
            <p className="text-sm text-neutral-700">
              Connected as{' '}
              <span className="font-medium text-neutral-900">{connection.accountIdentifier}</span>
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Only your free/busy times are read — never event titles, attendees or locations.
            </p>
            <button
              type="button"
              onClick={onDisconnect}
              disabled={disconnecting}
              className={`${buttonClass('secondary', 'sm')} mt-4`}
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-neutral-700">
              Your {label} is not connected. Until it is, you are reported as having no calendar
              data when someone checks availability — never as free.
            </p>
            <button
              type="button"
              onClick={onConnect}
              disabled={connecting}
              className={`${buttonClass('primary', 'sm')} mt-4`}
            >
              {connecting ? 'Redirecting…' : `Connect ${label}`}
            </button>
          </>
        )}
      </div>
    </Card>
  );
}
