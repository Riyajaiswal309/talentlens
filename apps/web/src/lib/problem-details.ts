/**
 * RFC 7807 `application/problem+json`, as the API actually emits it.
 *
 * MIRRORS `apps/api/src/common/filters/problem-details.filter.ts` EXACTLY.
 * Every error from the API — validation, permission, not-found, unexpected —
 * passes through that one filter, so this is the only error shape the client
 * ever has to understand.
 *
 * There is deliberately no `errors` array or field-path map: the filter joins
 * ValidationPipe's `string[]` into a single `detail` with `'; '`. Inventing a
 * richer shape here would be a client-side fiction the server never sends.
 */
export interface ProblemDetails {
  /** Always `about:blank` today; the filter does not mint problem type URIs. */
  type: string;
  /** Short status label, e.g. `Forbidden`, or NestJS's `error` field. */
  title: string;
  status: number;
  /**
   * Human-readable cause. Phase 1 §10.5 requires error text to name the
   * problem AND the fix, so this is what belongs on screen — not `title`.
   */
  detail: string;
  /** The request path that failed. */
  instance: string;
  /** NFR11 — quotable by the user when reporting a failure. */
  correlationId?: string;
}

/**
 * A failed API call, carrying the server's own explanation.
 *
 * WHY A CLASS AND NOT A PLAIN OBJECT. TanStack Query rejects with whatever is
 * thrown; an `Error` subclass keeps a real stack for the console while letting
 * every screen narrow with `instanceof` and read `problem.detail` directly.
 */
export class ApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    // `detail` is the sentence written for a human; `title` is a status label.
    super(problem.detail || problem.title);
    this.name = 'ApiError';
    this.problem = problem;
  }

  get status(): number {
    return this.problem.status;
  }

  get correlationId(): string | undefined {
    return this.problem.correlationId;
  }

  /** Not signed in, or the access token expired (§24.1 — 15-minute TTL). */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** Signed in, but §24.2 does not grant this role the action. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /**
   * Absent — or present but outside the caller's tenant.
   *
   * BR-06 refuses a foreign record with 404 rather than 403 precisely so the
   * two are indistinguishable, so the UI must not claim the record "exists but
   * is not yours".
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** DTO rejected by the global ValidationPipe (`whitelist`, strict). */
  get isValidation(): boolean {
    return this.status === 400;
  }

  /** A configured dependency did not answer — e.g. FR6.3's calendar outage. */
  get isUnavailable(): boolean {
    return this.status === 503;
  }

  /** The API answered, but with something we could not use. */
  get isServerError(): boolean {
    return this.status >= 500;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Coerce anything into a `ProblemDetails`.
 *
 * The wire is not always trustworthy: a proxy failure, an HTML error page or a
 * truncated body all reach the client as "not the shape we expected". Rather
 * than let a screen destructure `undefined`, every path ends in a complete
 * problem object, so error rendering has exactly one contract.
 */
export function toProblemDetails(
  body: unknown,
  fallback: { status: number; title: string; detail: string; instance: string },
): ProblemDetails {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const status = typeof record['status'] === 'number' ? record['status'] : fallback.status;

    // A body is only treated as a problem document if it carries the two
    // fields that make it one. Anything else is a foreign shape and gets the
    // fallback, so a 200-with-junk cannot masquerade as a structured error.
    if (typeof record['title'] === 'string' && typeof record['status'] === 'number') {
      return {
        type: typeof record['type'] === 'string' ? record['type'] : 'about:blank',
        title: record['title'],
        status,
        detail: typeof record['detail'] === 'string' ? record['detail'] : fallback.detail,
        instance: typeof record['instance'] === 'string' ? record['instance'] : fallback.instance,
        correlationId:
          typeof record['correlationId'] === 'string' ? record['correlationId'] : undefined,
      };
    }
  }

  return { type: 'about:blank', ...fallback };
}
