import { isApiError } from '../lib/problem-details';

/**
 * SY-01 — the error surface (Phase 1 Table 5.1: "Message, recovery action";
 * PRD §23.1 RFC 7807).
 *
 * IT PRINTS THE SERVER'S OWN SENTENCE. Every failure arrives as an `ApiError`
 * carrying `detail`, which §10.5 requires to name the problem AND the fix.
 * Substituting a generic "Something went wrong" would discard the only text
 * written to be read by the person looking at the screen.
 */
export function ErrorState({
  error,
  onRetry,
  title,
}: {
  error: unknown;
  /** Omit when nothing would change on a second attempt (403, 404). */
  onRetry?: () => void;
  title?: string;
}) {
  const { heading, detail, correlationId, retryable } = describe(error);

  return (
    /*
     * role="alert" so the failure is spoken as soon as it replaces the
     * loading state; a user who cannot see the panel appear would otherwise be
     * left on a screen that simply stopped.
     */
    <div
      role="alert"
      className="rounded-md border border-danger-700 bg-neutral-0 px-6 py-8 text-center"
    >
      <h2 className="text-base font-semibold text-danger-700">{title ?? heading}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-neutral-700">{detail}</p>

      {/*
        NFR11 — the correlation id is the one string that lets this exact
        request be found in the API logs, so it is shown rather than hidden in
        a console. Mono, because it is an identifier to be copied verbatim.
      */}
      {correlationId && (
        <p className="mt-3 font-mono text-xs text-neutral-500">
          Reference: <span className="select-all">{correlationId}</span>
        </p>
      )}

      {onRetry && retryable && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 h-10 rounded-md border border-neutral-300 bg-neutral-0 px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
        >
          Try again
        </button>
      )}
    </div>
  );
}

interface Described {
  heading: string;
  detail: string;
  correlationId?: string;
  retryable: boolean;
}

function describe(error: unknown): Described {
  if (!isApiError(error)) {
    // Not from the API at all — a render fault or a thrown non-Error. Nothing
    // useful can be attributed to the server, so say only what is true.
    return {
      heading: 'Something went wrong',
      detail: error instanceof Error ? error.message : 'An unexpected error occurred.',
      retryable: true,
    };
  }

  const base = { correlationId: error.correlationId, detail: error.problem.detail };

  /**
   * Some 404s carry no sentence at all.
   *
   * `JobAssignmentGuard` and several services throw a bare
   * `NotFoundException()`, so the filter falls back to the status label and
   * `detail` arrives as the literal string "Not Found" — which restates the
   * heading and leaves the reader no better off. §10.5 requires the message to
   * name the problem AND the fix, so where the server said nothing useful the
   * client supplies the sentence rather than echoing a label twice.
   *
   * Only when the server was silent. A real `detail` is always preferred.
   */
  const uninformative = (value: string, heading: string) => {
    const strip = (text: string) => text.replace(/[\s.]/g, '').toLowerCase();
    const empty = strip(value);
    // Compared against the SERVER'S title as well as our heading: the filter's
    // fallback copies `detail` from the status label ("Not Found"), which
    // matches neither our wording nor nothing at all.
    return !value.trim() || empty === strip(heading) || empty === strip(error.problem.title);
  };

  /*
   * 404 IS NOT ALWAYS "MISSING". BR-06 refuses a record belonging to another
   * tenant with 404 rather than 403, precisely so the two are indistinguishable
   * — so this wording must not claim the record does not exist anywhere, only
   * that it is not available here.
   */
  if (error.isNotFound) {
    const heading = 'Not available';
    return {
      ...base,
      heading,
      // Careful wording: this covers "does not exist" and "belongs to another
      // tenant" alike, and the UI must not pick one.
      detail: uninformative(base.detail, heading)
        ? 'This record does not exist, or it is not part of your company. Check the link, or go back to Jobs.'
        : base.detail,
      retryable: false,
    };
  }

  if (error.isForbidden) {
    // §24.2 settled it. Retrying sends the identical request and fails the
    // identical way, so no retry button is offered.
    const heading = 'You do not have access to this';
    return {
      ...base,
      heading,
      detail: uninformative(base.detail, heading)
        ? 'Your role does not include this action. Ask an administrator if you need it.'
        : base.detail,
      retryable: false,
    };
  }

  if (error.isUnavailable) {
    // FR6.3's shape: a configured dependency did not answer. Genuinely worth
    // retrying, and the server's detail already names the manual alternative.
    return { ...base, heading: 'Temporarily unavailable', retryable: true };
  }

  if (error.isValidation) {
    return { ...base, heading: 'That request could not be processed', retryable: false };
  }

  if (error.status === 0) {
    return { ...base, heading: 'Cannot reach TalentLens', retryable: true };
  }

  return { ...base, heading: 'Something went wrong', retryable: true };
}
