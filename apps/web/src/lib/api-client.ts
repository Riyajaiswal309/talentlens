import { ApiError, toProblemDetails } from './problem-details';

/**
 * The single door to the TalentLens API.
 *
 * ROOT-RELATIVE PATHS, NO BASE URL. Requests go to `/v1/...` on the app's own
 * origin and Vite forwards them to the API (see `vite.config.ts`). That is not
 * a shortcut: the API enables no CORS, and the refresh cookie is
 * `SameSite=Strict`, so a cross-origin client could neither read a response
 * nor send the cookie. Same-origin is the only configuration that works, and
 * hard-coding it here keeps a base-URL setting from quietly breaking auth.
 *
 * Every error leaves as an `ApiError` (PRD §23.1), so no caller inspects
 * `response.ok` or guesses at a body shape.
 */

const API_PREFIX = '/v1';

/** Values a query string may carry. Arrays repeat the key, as Express expects. */
type QueryValue = string | number | boolean | readonly string[] | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Serialised as JSON. Omit for GET/DELETE. */
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /**
   * Let a 401 through untouched instead of attempting silent refresh.
   *
   * REQUIRED ON THE AUTH ROUTES THEMSELVES. `/auth/login` answers 401 for a
   * wrong password — recovering from that would fire a pointless refresh on
   * every failed sign-in. `/auth/refresh` is stronger still: recovery *is*
   * refresh, so letting it recover would have the in-flight single-flight
   * promise await itself and deadlock.
   */
  skipAuthRecovery?: boolean;
}

/*
 * ─── Seams the auth layer fills in (Step 2) ──────────────────────────────
 *
 * Module-level rather than React context, because this file must stay usable
 * from TanStack Query functions that run outside the component tree. The auth
 * provider registers into these once, at mount.
 */

/** Supplies the current access token, or null when signed out. */
let accessTokenProvider: () => string | null = () => null;

/**
 * Given one 401, tries to obtain a fresh access token; null if it cannot.
 *
 * TODO(Step 2): the auth layer registers silent refresh here — a single-flight
 * call to `POST /v1/auth/refresh` (authenticated by the httpOnly cookie), so
 * concurrent 401s trigger exactly one refresh rather than a stampede. Until it
 * is registered a 401 propagates unchanged, which is the correct behaviour for
 * a client with no session.
 */
let unauthorizedRecovery: (() => Promise<string | null>) | null = null;

export function setAccessTokenProvider(provider: () => string | null): void {
  accessTokenProvider = provider;
}

export function setUnauthorizedRecovery(recover: (() => Promise<string | null>) | null): void {
  unauthorizedRecovery = recover;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // Undefined and null mean "not filtering by this", which is different from
    // filtering by an empty string — so they are dropped, never sent blank.
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }

  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function readProblem(response: Response, url: string): Promise<ApiError> {
  const fallback = {
    status: response.status,
    title: response.statusText || 'Error',
    detail: 'The server returned an error that could not be read.',
    instance: url,
  };

  let body: unknown = null;
  try {
    // Guard the parse rather than the content-type: a proxy or gateway failure
    // answers with HTML, and that must degrade to the fallback instead of
    // throwing a SyntaxError from inside the client.
    body = await response.json();
  } catch {
    body = null;
  }

  const problem = toProblemDetails(body, fallback);

  // The filter also mirrors the id into a header; prefer the body, but fall
  // back so a truncated response still gives the user something to quote.
  if (!problem.correlationId) {
    const header = response.headers.get('x-correlation-id');
    if (header) problem.correlationId = header;
  }

  return new ApiError(problem);
}

async function send(url: string, options: RequestOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    /*
     * The refresh token is an httpOnly cookie and is the only credential the
     * client cannot read. `same-origin` sends it on the proxied calls that
     * need it (`/v1/auth/refresh`, `/v1/auth/logout`) and never anywhere else.
     */
    credentials: 'same-origin',
  });
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, options.query);

  let response: Response;
  try {
    response = await send(url, options, accessTokenProvider());
  } catch (cause) {
    /*
     * fetch only rejects when the request never completed — the API is down,
     * the dev proxy has nothing to forward to, or the caller aborted. An
     * abort is the caller's own doing and is rethrown untouched so TanStack
     * Query can recognise it; anything else becomes a problem document with
     * the fix named, per Phase 1 §10.5.
     */
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({
      type: 'about:blank',
      title: 'Network Error',
      status: 0,
      detail: 'Could not reach the TalentLens API. Check that the API is running on port 3000.',
      instance: url,
    });
  }

  /*
   * ONE RETRY, ONLY ON 401, ONLY WITH A NEW TOKEN. Access tokens live 15
   * minutes (§24.1), so an expired one is ordinary rather than exceptional and
   * the user should not see it. The retry is capped at a single attempt: if
   * the replayed request is still 401 the session is genuinely over, and
   * looping would turn a signed-out user into an infinite request storm.
   */
  if (response.status === 401 && unauthorizedRecovery && !options.skipAuthRecovery) {
    const refreshed = await unauthorizedRecovery();
    if (refreshed) {
      try {
        response = await send(url, options, refreshed);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
        throw new ApiError({
          type: 'about:blank',
          title: 'Network Error',
          status: 0,
          detail: 'Could not reach the TalentLens API. Check that the API is running on port 3000.',
          instance: url,
        });
      }
    }
  }

  if (!response.ok) throw await readProblem(response, url);

  // 204, or any empty body: the caller's type says what it expects, and a
  // successful delete legitimately has nothing to return.
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError({
      type: 'about:blank',
      title: 'Invalid Response',
      status: response.status,
      detail: 'The API returned a response that was not valid JSON.',
      instance: url,
    });
  }
}

/**
 * Download a file the API streams (FR8.3 — `GET /v1/audit-logs/export`).
 *
 * WHY NOT A PLAIN `<a href>`. The access token lives in memory and travels as
 * an `Authorization` header; the only cookie is the refresh token, and it is
 * scoped `Path=/v1/auth`, so it is never sent to `/v1/audit-logs/export`. A
 * bare link would arrive unauthenticated and answer 401. Appending the token to
 * the query string would fix that and leak it into browser history and server
 * logs, which is worse than the problem.
 *
 * So the request goes through the normal authenticated path and the response is
 * turned into a download here. Errors still surface as `ApiError`, so a failed
 * export renders like every other failure.
 */
export async function apiDownload(
  path: string,
  fallbackFilename: string,
  options: Omit<RequestOptions, 'method' | 'body'> = {},
): Promise<void> {
  const url = buildUrl(path, options.query);
  let response = await send(url, { ...options, method: 'GET' }, accessTokenProvider());

  // One capped retry behind a silent refresh, matching `apiRequest`.
  if (response.status === 401 && !options.skipAuthRecovery && unauthorizedRecovery) {
    const token = await unauthorizedRecovery();
    if (token) response = await send(url, { ...options, method: 'GET' }, token);
  }

  if (!response.ok) throw await readProblem(response, url);

  // The server names the file in Content-Disposition; honour it when present.
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1]) : fallbackFilename;

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Released on the next tick: revoking synchronously can cancel the download
  // in some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

/**
 * POST multipart form data (FR2.1 — the public application carries a resume).
 *
 * WHY NOT `api.post`. That wrapper sets `Content-Type: application/json` and
 * `JSON.stringify`s the body, which would destroy a `FormData`. Here the header
 * is deliberately OMITTED so the browser sets `multipart/form-data` together
 * with the boundary — setting it by hand produces a boundary-less header the
 * server cannot parse.
 *
 * `Idempotency-Key` is supported by `POST /v1/applications`: a candidate who
 * double-submits, or whose connection drops mid-upload and retries, gets the
 * same application back rather than two.
 */
export async function apiUpload<T>(
  path: string,
  form: FormData,
  options: { idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const url = buildUrl(path);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  // Public endpoint: no token is attached, and none is needed.
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: options.signal,
    credentials: 'same-origin',
  });

  if (!response.ok) throw await readProblem(response, url);

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** Convenience wrappers — the verb is the only thing most callers vary. */
export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),

  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),

  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};
