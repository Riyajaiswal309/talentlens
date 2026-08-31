import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, Notice, buttonClass } from '../../components/ui';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState, SkeletonText } from '../../components/Skeleton';
import { useCompleteCalendarConnect } from './useCalendarConnections';

/**
 * FR6.1 — where the provider sends the user back (D40).
 *
 * WHY THE REDIRECT LANDS ON THE FRONTEND AND NOT THE API. A provider redirect
 * is a plain browser GET; it cannot carry a Bearer token, and the repository
 * forbids `@Public()` on calendar endpoints. So the provider returns here,
 * inside the session the user already holds, and this screen posts `code` and
 * `state` to `POST /v1/calendar/connections/:provider/complete` under that
 * session. Both halves of consent therefore stay authenticated, with no public
 * callback anywhere.
 *
 * THE STATE IS PASSED THROUGH UNTOUCHED. It was minted server-side, is bound to
 * the initiating user and provider, and is consumed exactly once. This screen
 * neither generates nor validates it — doing either on the client would make
 * the CSRF defence something an attacker could satisfy.
 *
 * NOTHING IS PRESENTED AS SUCCESS UNTIL THE API SAYS SO. A `code` in the URL
 * proves only that the provider redirected; the exchange can still fail on a
 * replayed state, a mismatched user, or a provider refusal.
 */
export function CalendarCallbackPage() {
  const [params] = useSearchParams();
  const complete = useCompleteCalendarConnect();

  const code = params.get('code') ?? undefined;
  const state = params.get('state') ?? '';
  const providerError = params.get('error') ?? undefined;
  /*
   * The provider is carried on our own redirect URI rather than read from the
   * provider's response, so it cannot be steered by the query string alone.
   * `/complete` re-checks it against the state it minted regardless.
   */
  const provider = params.get('provider') ?? '';

  // React 18 StrictMode double-mounts in development; the state is single-use,
  // so a second exchange would fail against a token the first one consumed.
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    if (!provider || !state) return;
    submitted.current = true;
    complete.mutate({ provider, code, state, error: providerError });
  }, [provider, state, code, providerError, complete]);

  const backToSettings = (
    <Link to="/settings/calendar" className={buttonClass('secondary', 'sm')}>
      Back to calendar connections
    </Link>
  );

  if (!provider || !state) {
    return (
      <Shell>
        <ErrorState as="h1" title="This callback is missing information" error={{}} />
        <p className="mt-3 text-sm text-neutral-600">
          The address is missing the provider or the authorisation state, so there is nothing to
          complete. Start the connection again from the calendar settings screen.
        </p>
        <div className="mt-4">{backToSettings}</div>
      </Shell>
    );
  }

  if (complete.isPending || complete.isIdle) {
    return (
      <Shell>
        <LoadingState label="Finishing the calendar connection…">
          <Card>
            <div className="p-5">
              <SkeletonText lines={2} />
            </div>
          </Card>
        </LoadingState>
      </Shell>
    );
  }

  if (complete.isError) {
    return (
      <Shell>
        {/*
          The API distinguishes these for us: 400 for a declined or rejected
          authorisation, 401 for a replayed or expired state, 403 for a state
          belonging to another user, 503 for a provider that did not answer.
          `ErrorState` prints the server's own sentence rather than guessing.
        */}
        <ErrorState as="h1" error={complete.error} title="The calendar was not connected" />
        <p className="mt-3 text-sm text-neutral-600">
          Nothing has been stored. You can start the connection again.
        </p>
        <div className="mt-4">{backToSettings}</div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Calendar connected</h1>
      <div className="mt-4">
        <Notice tone="success" title={`Connected as ${complete.data.accountIdentifier}`}>
          Your free/busy times can now be read when an interview is being arranged. Event titles,
          attendees and locations are never read.
        </Notice>
      </div>
      <div className="mt-4">{backToSettings}</div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-2xl">{children}</div>;
}
