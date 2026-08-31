import { useId, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { LogoMark } from '../../components/icons';
import { isApiError } from '../../lib/problem-details';

/**
 * PRD §24.1 sets a 12-character minimum, enforced server-side by `LoginDto`.
 *
 * Mirrored here so a too-short password never becomes a round trip: the API
 * answers that case with a 400 whose message is about the FIELD, while a wrong
 * password is a 401 about the CREDENTIALS. Checking locally keeps those two
 * apart on screen — the user is told what to fix, not that their password was
 * rejected.
 */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Where a signed-in recruiter lands when they had no destination in mind.
 *
 * RC-01, matching the catch-all in `App.tsx` — §4.1 puts Dashboard first in the
 * recruiter IA, and a cross-requisition overview is the useful opening screen.
 * A deep link still wins: `state.from` is preferred over this, so signing in
 * after being bounced off a protected URL returns you to that URL.
 */
const DEFAULT_DESTINATION = '/dashboard';

interface LocationState {
  from?: { pathname?: string };
}

/**
 * SC-01 — Login (Phase 1 Table 5.1).
 *
 * States the inventory requires: invalid credentials, and loading. MFA (SC-02)
 * and password reset (SC-03) are deliberately absent — the API exposes no
 * endpoint for either, and SC-03 is explicitly "not designed in Phase 1", so a
 * link here would promise a screen that does not exist.
 */
export function LoginPage() {
  const { status, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const emailId = useId();
  const passwordId = useId();
  const passwordErrorId = `${passwordId}-error`;
  const formErrorId = useId();

  // Already signed in — nothing to do here. Sending them to the app rather
  // than showing a form they cannot use.
  if (status === 'authenticated') {
    const from = (location.state as LocationState | null)?.from?.pathname;
    return <Navigate to={from ?? DEFAULT_DESTINATION} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    setFormError(null);

    // Client-side gate (§24.1). Blocks the request entirely — the server would
    // return a 400 about length, which reads as a rejected sign-in attempt
    // rather than an unfinished one.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      const from = (location.state as LocationState | null)?.from?.pathname;
      navigate(from ?? DEFAULT_DESTINATION, { replace: true });
    } catch (error) {
      /*
       * The server's own words. §23.1 gives every failure a `detail` written to
       * name the problem and the fix, and AuthService deliberately returns one
       * generic message for a wrong email and a wrong password alike — so
       * echoing it cannot disclose whether the account exists.
       */
      setFormError(
        isApiError(error)
          ? error.problem.detail
          : 'Sign-in failed. Check that the TalentLens API is running and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-neutral-50 p-6">
      {/* Same decorative wash as the landing hero, so the two read as one product. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50rem_25rem_at_50%_-10%,theme(colors.primary.50),transparent)]"
      />
      <div className="relative w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <Link to="/" className="rounded-sm" aria-label="TalentLens home">
            <LogoMark className="h-11 w-11" />
          </Link>
          <h1 className="mt-4 text-2xl font-semibold text-neutral-900">TalentLens</h1>
          <p className="mt-1 text-sm text-neutral-500">Sign in to the recruiter workspace</p>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          noValidate
          className="rounded-xl border border-neutral-200 bg-neutral-0 p-6 shadow-lg"
        >
          {/*
            role="alert" so the failure is announced the moment it appears —
            a sighted user sees it, and without this a screen-reader user would
            be left on a form that silently did nothing (NFR4).
          */}
          {formError && (
            <div
              id={formErrorId}
              role="alert"
              className="mb-4 rounded-md border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {formError}
            </div>
          )}

          <div className="mb-4">
            {/* Label above the field, always visible — Task 10 §10.4 forbids
                using the placeholder as the label. */}
            <label htmlFor={emailId} className="mb-1 block text-sm font-semibold text-neutral-900">
              Email <span className="font-normal text-neutral-500">(Required)</span>
            </label>
            <input
              id={emailId}
              type="email"
              name="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-10 w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400"
            />
          </div>

          <div className="mb-6">
            <label
              htmlFor={passwordId}
              className="mb-1 block text-sm font-semibold text-neutral-900"
            >
              Password <span className="font-normal text-neutral-500">(Required)</span>
            </label>
            <input
              id={passwordId}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? passwordErrorId : undefined}
              className={`h-10 w-full rounded-md border px-3 text-sm text-neutral-900 transition-colors ${
                fieldError ? 'border-danger-700' : 'border-neutral-300'
              }`}
            />
            {fieldError && (
              <p id={passwordErrorId} className="mt-1 text-sm text-danger-700">
                {fieldError}
              </p>
            )}
          </div>

          {/*
            Disabled carries aria-disabled too, and the label is kept while
            loading rather than swapped for a spinner alone (Task 8 §8.6).
          */}
          <button
            type="submit"
            disabled={submitting}
            aria-disabled={submitting}
            className="h-11 w-full rounded-md bg-primary-700 px-4 text-sm font-semibold text-neutral-0 shadow-sm transition-colors hover:bg-primary-800 disabled:opacity-40"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
