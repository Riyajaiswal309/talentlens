/**
 * Bounds each test worker's database connection pool.
 *
 * THE PROBLEM. Postgres allows 100 connections (3 reserved for superusers).
 * Prisma's default pool is `num_cpus * 2 + 1` — 17 on an 8-core machine — and
 * it opens that pool PER CLIENT. Twenty-four of the suites construct a second
 * "owner" client alongside the application one, so a single worker can hold 34
 * connections and Jest's default parallelism (one worker per core) can demand
 * well over 200. The pool then blocks waiting for a free connection, and a
 * `beforeAll` that only calls `$connect()` blows the 5-second hook timeout.
 *
 * That is the whole cause of the intermittent full-suite failures: it lands on
 * a different suite each run, always as a timeout in setup rather than an
 * assertion, and every suite passes in isolation.
 *
 * THE FIX. Cap the pool per client so the total stays inside the budget:
 *
 *     8 workers x 2 clients x 3 connections = 48, against ~97 usable.
 *
 * Three rather than one, because a suite may legitimately hold two
 * connections at once — `scheduling.spec` fires two concurrent confirmations
 * to prove the slot race is settled in the database — and one more gives
 * headroom without approaching the limit.
 *
 * WHY HERE. `setupFiles` runs inside each worker BEFORE the test module is
 * imported, which is the only hook early enough: the suites read
 * `process.env.DATABASE_URL` at module scope, and `ConfigModule` later loads
 * `.env` with dotenv semantics that leave an already-set variable alone. So
 * setting it here reaches both the hand-built owner clients and the
 * application's `PrismaService`.
 *
 * TEST-ONLY. Nothing outside Jest reads this file. Production connection
 * sizing is untouched — a deployed instance has one client per process, not
 * thirty-four across eight workers, and would be wrong to constrain this way.
 */
const POOL_LIMIT = 3;

/** Add the cap without disturbing a URL that already states one. */
function capped(url: string): string {
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${POOL_LIMIT}`;
}

/*
 * The same default the suites fall back to when the variable is unset, so the
 * capped URL points at exactly the database they would have used anyway.
 */
const DEFAULT_OWNER_URL =
  'postgresql://talentlens:talentlens_dev@localhost:5432/talentlens?schema=public';

process.env.DATABASE_URL = capped(process.env.DATABASE_URL ?? DEFAULT_OWNER_URL);

// Only if the deployment defines a separate application role. Left unset
// otherwise, so PrismaService keeps its documented fallback to DATABASE_URL.
if (process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL = capped(process.env.APP_DATABASE_URL);
}

/*
 * THE RESUME WORKER MUST NOT RUN DURING TESTS.
 *
 * `.env` now sets `RESUME_WORKER_ENABLED=true` so a local demo parses uploads
 * (FR3). `ConfigModule` loads that same file in tests, which started a real
 * BullMQ worker alongside the suite — it then drained the specs' own fixtures
 * and marked them FAILED, breaking assertions that legitimately expect
 * `parse_status = PENDING`.
 *
 * Forced off here, for the same reason the pool is capped above: a test run
 * must not depend on what a developer happens to have in `.env`. Specs that
 * exercise the worker construct it directly and call `handle()` themselves,
 * which is unaffected by this switch.
 */
process.env.RESUME_WORKER_ENABLED = 'false';
