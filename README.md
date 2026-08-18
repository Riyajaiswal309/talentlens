# TalentLens

AI-Powered Recruitment & Applicant Tracking System.
B.Tech CSE final-year project · Riya Jaiswal · GD Goenka University · 2026–27

A multi-tenant ATS with a working recruiter console, a role-based NestJS API, and an
AI-screening pipeline that is **integrated but not trained**. The guiding rule of the
build is that the interface never claims more than the data supports: every place the
API cannot answer a question, the screen says so instead of showing a plausible number.

---

## Contents

- [Problem statement](#problem-statement)
- [Solution](#solution)
- [Main features](#main-features)
- [Tech stack](#tech-stack)
- [Governing documents](#governing-documents)
- [Repository layout](#repository-layout)
- [Backend architecture](#backend-architecture-as-implemented)
- [Authentication and RBAC](#authentication-and-rbac)
- [Multi-tenancy and data isolation](#multi-tenancy-and-data-isolation)
- [Frontend architecture](#frontend-architecture)
- [Implemented recruiter screens](#implemented-recruiter-screens)
- [Key API interactions](#key-api-interactions)
- [Deferred screens and current limitations](#deferred-screens-and-current-limitations)
- [Running locally](#running-locally)
- [Environment variables](#environment-variables)
- [Build, test and verification commands](#build-test-and-verification-commands)
- [Rules this codebase enforces](#rules-this-codebase-enforces)
- [Phase status](#phase-status)

---

## Problem statement

A single open role can attract hundreds of applications. Recruiters end up doing three
jobs at once: reading resumes, keeping every candidate's stage straight across
spreadsheets and inboxes, and coordinating interviewer calendars. Two failure modes
follow.

1. **Volume beats attention.** Screening is inconsistent because it depends on which
   resume was read at 9 a.m. and which at 6 p.m. Qualified candidates are missed, and
   there is no record of why anyone was moved forward.
2. **Automation is trusted blindly.** The usual answer — a keyword filter or an opaque
   "match score" — replaces one bias with another. A score with no explanation cannot be
   challenged, and a system that auto-rejects has made a hiring decision no one can
   account for.

An ATS therefore has to solve a governance problem, not only a throughput problem: it
must make screening faster **and** leave every decision attributable to a human, with
the reasoning on record.

## Solution

TalentLens splits the work along that line.

- **The system ranks and explains. A human decides.** Scoring is advisory. A score
  cannot exist without a stored rationale (a NOT NULL column, not a convention), and no
  automated path can reject a candidate — terminal stage changes require a human actor
  and a confirmation step.
- **Every consequential write is audited.** Score overrides, terminal transitions and
  erasures land in an append-only `audit_logs` table; the API connects as a restricted
  database role precisely so it cannot bypass that.
- **Fairness is a fixed input contract, not a promise.** Ranking draws on six named
  features and nothing else. Protected attributes are structurally excluded — there is
  no code path that can add one.
- **The recruiter console is honest about gaps.** Where the API has no data (a total
  applicant count, a cross-job review queue, an export), the UI shows an explanation
  rather than a zero. That discipline is why the demo can be trusted.

---

## Main features

### Implemented and demonstrable

| Area                    | What works                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Authentication          | Email/password login, Argon2id hashes, 15-minute access token, rotating 7-day refresh cookie       |
| Role-based access       | Four roles; recruiter console gated to `RECRUITER` and `ADMIN` on both client and server           |
| Job requisitions        | List with department/status filters and cursor pagination, create, edit, publish, close, duplicate |
| Candidate management    | Per-job candidate list, full application detail, comment thread                                    |
| Pipeline                | Six-stage board, single and bulk stage moves, optimistic update with rollback                      |
| Structured interviewing | Scorecards with 1–5 ratings, per-competency notes, one scorecard per reviewer per application      |
| Ranking configuration   | Per-job weights over the six permitted features, live sum validation against the server tolerance  |
| Analytics               | Conversion funnel per stage with drop-off, ratios and median time-in-stage                         |
| Audit trail             | Append-only log with an Admin-only read/export API                                                 |
| Interview scheduling    | Candidate-facing scheduling links signed with a single-purpose expiring token                      |
| Calendar integration    | Google and Microsoft OAuth connections, encrypted refresh tokens, interviewer availability         |

### Integrated but not trained

The parse-and-score pipeline exists end to end — BullMQ queue, worker, `parsed_profiles`,
atomic `match_scores` writes, ranking weights, parse review. **No model is trained.**
`apps/ai-service` serves a deterministic reference stub, `reference-stub@not-trained-v0`.
See [Deferred screens and current limitations](#deferred-screens-and-current-limitations).

---

## Tech stack

| Layer          | Choice                                                                |
| -------------- | --------------------------------------------------------------------- |
| Language       | TypeScript 5.7 (strict), Python 3.11 for the AI service               |
| Monorepo       | pnpm 9.15.0 workspaces, Node 20+                                      |
| Backend        | NestJS 10, Prisma 6.19.3                                              |
| Database       | PostgreSQL 15 — 19 models, 10 migrations                              |
| Cache / queue  | Redis 7, BullMQ                                                       |
| Object storage | S3 (LocalStack 3 locally) for resumes                                 |
| Passwords      | Argon2id                                                              |
| Frontend       | React 18, Vite 5, react-router-dom, TanStack Query v5, Tailwind CSS 3 |
| API docs       | Swagger / OpenAPI at `/api/docs`                                      |
| Testing        | Jest — 43 API spec files                                              |
| Tooling        | ESLint, Prettier, Husky + lint-staged                                 |

**Deliberately absent from the frontend:** no charting library, no drag-and-drop
library, no component library, no state-management library beyond TanStack Query. The
funnel bars are CSS; the pipeline moves through an accessible menu rather than
drag-only interaction (WCAG 2.1.1 — keyboard operability).

---

## Governing documents

Everything in this repository traces to these. They are the source of truth, not the code.

| Document                            | Role                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| `docs/master-prd-v3.pdf`            | Master PRD v3.0 — requirements, architecture, business rules |
| `docs/phase1-requirements-ux.pdf`   | Phase 1 — traceability, screens, flows, design system        |
| `docs/phase1-to-phase2-handoff.pdf` | Handoff v1.1 — API contracts, entities, Definition of Done   |
| `docs/PRD-AMENDMENTS.md`            | What the build does that the PRD/Handoff do not yet say      |

Requirement codes used throughout the code and this README (`RC-01`, `FR4.5`, `BR-02`,
`§7.2`) refer to those documents.

---

## Repository layout

```
talentlens/
├── apps/
│   ├── web/           React 18 + Vite + TypeScript + Tailwind — recruiter console
│   ├── api/           NestJS core API + Prisma schema, migrations, seed
│   └── ai-service/    FastAPI — Phase 3 integration; reference stub, NOT a model
├── packages/
│   └── shared-types/  USER_ROLES and DEFAULT_PIPELINE_STAGES, shared by web and api
├── docs/              PRD and phase documents
└── docker-compose.yml Postgres 15 + Redis 7 + LocalStack S3
```

---

## Backend architecture (as implemented)

**NestJS modules under a global `/v1` prefix.** 23 controllers, 48 HTTP route handlers.
Swagger is served at `/api/docs`. `GET /health` is deliberately outside the prefix and
unauthenticated so a container probe can reach it.

Module groups: `auth`, `jobs` (+ `public-jobs`), `applications` (+ `job-candidates`),
`pipeline`, `scorecards` (+ `comments`, `reviews`), `interviews` (+ `scheduling`,
`availability`), `calendar`, `analytics`, `ai` (`ranking-weights`, `score-override`,
`parse-review`), `admin` (`users`, `ai-scoring`, `candidate-erasure`), `audit`, `health`.

**Errors are RFC 7807.** A global exception filter returns
`application/problem+json` for every failure:

```json
{
  "type": "https://talentlens.dev/problems/not-found",
  "title": "Not found",
  "status": 404,
  "detail": "Job not found",
  "instance": "/v1/jobs/…",
  "correlationId": "…"
}
```

The frontend has no ad-hoc error handling: one `ApiError` class parses this shape, and
every screen renders from it.

**Validation is whitelist-only.** The global `ValidationPipe` runs with
`forbidNonWhitelisted`, so an undeclared query parameter is a 400 rather than a silently
ignored filter. This is why the candidate list ships without invented filters — the DTO
accepts only `cursor` and `limit`.

**Guard chain**, applied in this order:

```
JwtAuthGuard → RolesGuard → TenantGuard → JobAssignmentGuard → CandidateOwnershipGuard
```

Authentication first, then role, then tenant, then per-record scoping — so a
cross-tenant request is rejected on tenancy grounds, never leaking that the record
exists.

**Pagination is cursor-based** (PRD §23.1): responses are `{ data, nextCursor }` where
`nextCursor` is the id of the last row. Forward-only — no `prevCursor` and no totals.
The UI therefore reports "20 loaded", never "20 of 147".

**Two-role database access.** `DATABASE_URL` is the owner role and runs migrations;
`APP_DATABASE_URL` is a restricted role the API connects as at runtime. In PostgreSQL a
table owner bypasses `REVOKE`, so an append-only `audit_logs` table is only append-only
if the application is not the owner.

**Asynchronous work.** Resume parsing and scoring run through a BullMQ worker that calls
the Python AI service over HTTP. The worker is opt-in via `RESUME_WORKER_ENABLED`
because it holds a Redis connection open and reaches an external process.

---

## Authentication and RBAC

**Token model.**

| Token         | Lifetime | Storage                                                               |
| ------------- | -------- | --------------------------------------------------------------------- |
| Access token  | 15 min   | **In memory only** — never `localStorage`, never `sessionStorage`     |
| Refresh token | 7 days   | httpOnly cookie, `Path=/v1/auth`, `SameSite=Strict`, `Max-Age=604800` |

The refresh token is **rotated on every use and is single-use**: replaying one fails.
Keeping the access token out of web storage means an XSS payload cannot read it, and the
refresh cookie is unreadable to JavaScript by construction. The cost is that a page
reload starts with no token — handled by the bootstrap flow below.

The two JWT secrets must differ; the API refuses to start if they match, because a
shared secret would let an access token be replayed as a refresh token.

**Single-flight refresh.** On reload, several queries fire at once and all get 401. Since
the refresh token is single-use, three parallel refreshes mean one success and two
failures — i.e. a silent logout. `apps/web/src/auth/session.ts` holds one shared
in-flight refresh promise that all callers await. This was verified against the live
API: three concurrent refreshes on one cookie produce 1×200 and 2×401.

**Three-state session.** `AuthStatus` is `bootstrapping | authenticated | unauthenticated`.
Distinguishing "we have not asked yet" from "not signed in" is load-bearing: collapsing
them bounces every deep-link reload to `/login`.

**Roles** (`packages/shared-types`): `ADMIN`, `RECRUITER`, `HIRING_MANAGER`, `CANDIDATE`.

Enforcement is in two independent places:

- **Server** — `@Roles(...)` on controllers, checked by `RolesGuard`. This is the real
  boundary. Every route under `audit-logs` and `admin/*` is `ADMIN`-only.
- **Client** — `RequireAuth` (redirects to `/login`, preserving the intended
  destination) then `RequireRole` (`RECRUITER` and `ADMIN` only; anyone else gets an
  explicit "This area is not available to you"). This is a usability layer, not
  security: it stops a hiring manager landing on a screen whose every request would 403.

Verified: all 12 routes redirect a signed-out visitor to `/login`; `ADMIN` reaches all
10 recruiter screens; `HIRING_MANAGER` and `CANDIDATE` are denied on all of them.

---

## Multi-tenancy and data isolation

Tenancy is by `company_id`. Three details matter, and all three are as implemented
rather than as an ideal design:

**1. Tenancy is reached through the job.** `applications` and `calendar_connections`
carry no `company_id` column. A recruiter's access to an application is resolved through
`application.job.companyId`, which is the single source of truth. There is no second
copy of the tenant id to drift out of sync.

**2. `candidates` is deliberately not tenant-scoped.** A person applies through a public
endpoint before any tenant relationship exists, so the candidate record cannot belong to
a company. Isolation of candidate data is enforced at the _application_ level — the join
that makes a candidate visible to a recruiter.

**3. A foreign record returns 404, never 403** (BR-06). A 403 confirms that the id
exists, which is itself a cross-tenant leak: an attacker could enumerate a competitor's
job ids by reading status codes. `TenantGuard` therefore answers "not found" for
anything outside the caller's company, and the frontend's error states are written for a
404 accordingly.

`JobAssignmentGuard` narrows further where a requirement calls for it (a hiring manager
sees only jobs they are assigned to), and `CandidateOwnershipGuard` restricts a candidate
to their own applications.

---

## Frontend architecture

`apps/web` — Vite + React 18, TypeScript strict with `noUncheckedIndexedAccess`,
`noUnusedLocals` and `noUnusedParameters`.

```
apps/web/src/
├── main.tsx              QueryClientProvider > BrowserRouter > AuthProvider > App
├── App.tsx               Route table; RequireAuth > RequireRole > RecruiterLayout
├── lib/
│   ├── api-client.ts     Root-relative /v1 fetch wrapper, one capped 401 retry
│   └── problem-details.ts RFC 7807 parsing; ApiError with status predicates
├── auth/                 session.ts, AuthContext, RequireAuth, RequireRole
├── layouts/              RecruiterLayout, navigation.ts, Breadcrumbs
├── components/           Skeleton, LoadingState, EmptyState, ErrorState
└── features/
    ├── auth/             SC-01 login
    ├── jobs/             RC-02, RC-03, RC-04, RC-08
    ├── candidates/       RC-05, RC-06, RC-13
    ├── pipeline/         RC-09, RC-10
    ├── analytics/        RC-12
    └── dashboard/        RC-01
```

**The Vite dev proxy is mandatory, not a convenience.** `/v1` is proxied to
`localhost:3000` for two independent reasons: the API does not call
`app.enableCors()`, and the refresh cookie is `SameSite=Strict` — so a cross-origin
frontend could not send it even if CORS were open. Same-origin is the only configuration
in which the session works. `api-client.ts` therefore issues root-relative requests with
`credentials: 'same-origin'`.

**Server state lives in TanStack Query.** There is no client-side store. Query retry is
configured never to repeat a 4xx — retrying a 404 or a 403 only delays the error state.

**Four shared state components** cover the four things every data screen must express:
`LoadingState` (skeletons, `role="status"`, `aria-live="polite"`, `aria-busy`),
`EmptyState` (with distinct `empty` and `filtered` variants — "no candidates yet" is a
different message from "no candidates match your filter"), `ErrorState` (renders from
`ApiError.status`; no retry button for 400/403/404, which retrying cannot fix), and
`Skeleton`.

**Breadcrumbs use a registry.** URLs carry ids (`/jobs/:jobId/candidates/:applicationId`),
so pages register their own human-readable title via `useBreadcrumbLabel(id, label)`
rather than the breadcrumb guessing from the path.

**The FR4.5 AI-disabled variant is tri-state.** When a job has AI scoring off, score and
rationale columns are **removed entirely, not greyed** — a greyed column reads as "the
score failed to load". Because the job flag arrives in a separate request from the rows,
`aiScoringEnabled` is modelled as `boolean | undefined`; only a definitive `false` shows
the disabled notice, and only a definitive `true` renders the score column. Defaulting
the unknown window to `true` produced a score column that appeared and then vanished.

**Design system** (`apps/web/tailwind.config.ts`): neutral 0/100/300/500/700/900,
primary 50/600/700, success/warning/danger/info 700; radii 4/8/12. One semantic rule is
enforced throughout — score magnitude uses the neutral/primary ramp and **never**
success/danger, because red on a low score reads as a rejection recommendation the
system is forbidden to make (BR-01).

**Accessibility (NFR4, WCAG 2.1 AA).** Every screen has exactly one `<h1>` and one
`<main>`; navs are labelled; no unlabelled inputs or unnamed buttons; no positive
`tabindex`. The mobile sidebar drawer is unmounted when closed so it leaves the tab
order. Stage moves are available from a keyboard-operable menu, not drag-only.

---

## Implemented recruiter screens

Eleven screens, all against the real API. Landing route after sign-in is `/dashboard`.

| Code  | Screen           | Route                                    | Notes                                                                        |
| ----- | ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| SC-01 | Login            | `/login`                                 | 12-character minimum checked client-side; shows the API's own 401 message    |
| RC-01 | Dashboard        | `/dashboard`                             | Open requisitions, applications, hired                                       |
| RC-02 | Job list         | `/jobs`                                  | Debounced department filter, status filter, cursor pagination                |
| RC-03 | Create / edit    | `/jobs/new`, `/jobs/:jobId/edit`         | Skills input; status options limited to transitions the API accepts          |
| RC-04 | Job detail       | `/jobs/:jobId`                           | Publish and Close behind confirmation; closed jobs render read-only          |
| RC-05 | Candidate list   | `/jobs/:jobId/candidates`                | "Load more", not numbered pages; FR4.5 score column                          |
| RC-06 | Candidate detail | `/jobs/:jobId/candidates/:applicationId` | Application record, comment thread, scorecards                               |
| RC-08 | Ranking weights  | `/jobs/:jobId/ranking-weights`           | Six fixed features; live total against the ±0.001 server tolerance           |
| RC-09 | Pipeline board   | `/jobs/:jobId/pipeline`                  | Six columns; optimistic move with rollback                                   |
| RC-10 | Bulk actions     | (within RC-09)                           | Multi-select bulk stage change, capped at the server's 100-application limit |
| RC-12 | Analytics funnel | `/analytics`                             | CSS bars; `null` conversion and time values render as `—`, never `0%`        |
| RC-13 | Scorecards       | (within RC-06)                           | 1–5 ratings; a duplicate scorecard surfaces the server's 409                 |

Two implementation notes worth stating, because both are workarounds:

- **The pipeline stage axis has no dedicated endpoint.** `GET /v1/analytics/funnel?jobId=`
  returns each stage's `name`, `position` and `isTerminal` even for a job with zero
  applications, so the board derives its columns from there. For a job id the funnel
  endpoint will not accept, the board falls back to the six `DEFAULT_PIPELINE_STAGES`
  from `packages/shared-types` and says on screen that it has done so.
- **`GET /v1/jobs/:id/candidates` accepts only `cursor` and `limit`.** The spec's search,
  stage, score-range and flagged filters are therefore absent rather than faked, since
  `forbidNonWhitelisted` turns an invented parameter into a 400.

### Things the spec asks for that this build omits and explains on screen

Each of these has no backing data or endpoint, so the screen states the reason instead of
rendering a zero: total applicant count per job (RC-02), analytics export (RC-12),
cross-job "awaiting review" count (RC-01), candidate tagging (RC-10), parsed profile,
activity timeline and stage history (RC-06), stage filter (RC-05 / RC-09), and pipeline
stage configuration (RC-03).

---

## Key API interactions

| Screen            | Requests                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Login             | `POST /v1/auth/login` → access token + refresh cookie; `GET /v1/auth/me` for identity    |
| Session bootstrap | `POST /v1/auth/refresh` (single-flight); `POST /v1/auth/logout`                          |
| Dashboard         | `GET /v1/jobs` per status; `GET /v1/analytics/funnel`                                    |
| Job list          | `GET /v1/jobs?department=&status=&cursor=&limit=20`                                      |
| Job create/edit   | `POST /v1/jobs`, `PATCH /v1/jobs/:id`, `POST /v1/jobs/:id/duplicate`                     |
| Job detail        | `GET /v1/jobs/:id`; publish/close via `PATCH /v1/jobs/:id { status }`                    |
| Candidate list    | `GET /v1/jobs/:id/candidates?cursor=&limit=`                                             |
| Candidate detail  | `GET /v1/applications/:id`, `.../comments`, `.../scorecards`, `.../interviews`           |
| Comments          | `POST /v1/applications/:id/comments` (body ≤ 5000 chars, must be non-blank)              |
| Scorecards        | `POST /v1/applications/:id/scorecards` (ratings 1–5; duplicate → 409)                    |
| Pipeline          | `PATCH /v1/applications/:id/stage`; bulk `PATCH /v1/applications/bulk/stage` (≤ 100 ids) |
| Ranking weights   | `GET` / `PUT /v1/jobs/:id/ranking-weights` (six features, sum 1.0 ± 0.001)               |
| Analytics         | `GET /v1/analytics/funnel?jobId=&from=&to=`                                              |

Terminal stage transitions (Hired, Rejected) require an explicit human confirmation and
are recorded in the audit log (BR-01, BR-03).

`PUT /ranking-weights` returns a `rescoreStatus`. It is printed verbatim: with no model
running it is `not_applicable`, and the screen says the weighting was stored and **no
candidate was re-ranked** rather than claiming a re-rank happened.

---

## Deferred screens and current limitations

Three specified recruiter screens are **not implemented**. Each is blocked on missing
backend capability, not on frontend work — building them would mean inventing data.

### RC-07 — Score Override

Blocked: there are no `match_scores` rows in the demo tenant, and the schema has no
`override_score` column. `PATCH /v1/applications/:id/score` exists, but with nothing to
override there is no path to exercise or demonstrate. The candidate list already renders
an "Overridden" badge for a score that carries the flag.

### RC-11 — Interviews

Blocked: there is no recruiter-visible interviewer directory. `GET /v1/admin/users` is
`ADMIN`-only, so a recruiter cannot populate an interviewer picker. The scheduling and
availability APIs are implemented and tested; the recruiter-facing screen that would
drive them is not. It appears in the sidebar marked "Later".

### RC-14 — Parse Review Queue

Blocked: no resume parser runs. `parsed_profiles` is empty and `parseStatus` is always
`PENDING`, so a review queue would list nothing. There is also no cross-job aggregate
endpoint — `GET /v1/jobs/:id/parse-review` is per-job only. Also marked "Later".

### Other known gaps

- **No AI model.** PRD §19.2 requires consent-gated historical application data,
  recruiter accept/reject/hire labels, a licensed resume corpus, a human-verified golden
  NER dataset and an access-restricted fairness dataset. None exists here, so §19.6's
  promotion gates cannot be evaluated and its fairness gate has no override path.
  `reference-stub@not-trained-v0` is not a trained model, not validated, not promotable,
  and not evidence of parsing, ranking or fairness performance.
- **No stage-history read endpoint**, so RC-06 cannot show an activity timeline.
- **No analytics export endpoint**, so RC-12 offers no Export.
- **No tag endpoint or column**, so RC-10 offers no Tag action.
- **No frontend test suite.** `apps/web`'s `test` script is a placeholder; verification
  was done by typecheck, lint, build and a scripted browser QA pass.
- **UUID validation is inconsistent** between `@IsUUID('4')` in DTOs and the unversioned
  `ParseUUIDPipe` in params. A non-v4 UUID is accepted by one and rejected by the other;
  a seeded job with a non-v4 id is reachable but cannot be applied to. Not fixed here —
  it touches the API contract, which is outside a documentation change.
- **Calendar OAuth is unconfigured locally.** Without provider credentials the calendar
  connection flow cannot be demonstrated. A provider with no credentials is treated as
  absent rather than as an outage: availability reports `notConnected` instead of 503.

---

## Running locally

### Prerequisites

| Tool    | Required                       | Why                                   |
| ------- | ------------------------------ | ------------------------------------- |
| Node.js | **20+** (PRD §16 specifies 20) | Core API and web build                |
| pnpm    | 9.15.0                         | Workspace manager (PRD §16.1)         |
| Docker  | Any recent                     | Postgres 15 + Redis 7 + LocalStack S3 |
| Python  | **3.11** (PRD §16)             | AI service — reference stub           |

Install pnpm without touching system directories:

```bash
mkdir -p ~/.local/bin
corepack enable --install-directory ~/.local/bin pnpm
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc to persist
```

### Setup

```bash
# 1. Environment
cp .env.example .env
#    Generate the secrets: openssl rand -base64 48
#    JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ.

# 2. Dependencies
pnpm install

# 3. Infrastructure
docker compose up -d          # Postgres 15 + Redis 7 + LocalStack
#    Or just what the console needs:
#    docker compose up -d postgres redis

# 4. Database — run from apps/api WITH .env exported (see the note below)
cd apps/api
set -a && . ../../.env && set +a
pnpm prisma:migrate
pnpm prisma:seed
cd ../..

# 5. Run both apps
pnpm dev
```

> **Why step 4 exports `.env` by hand.** The running API loads the root `.env`
> itself — `app.module.ts` calls `ConfigModule.forRoot({ envFilePath: ['../../.env'] })`
> — which is why `pnpm dev` needs no extra setup. The **Prisma CLI does not**: it looks
> for `.env` beside the schema or in the current directory, never at the monorepo root,
> so `pnpm --filter @talentlens/api prisma:migrate` alone fails with
> `P1012 — Environment variable not found: DATABASE_URL`. Exporting `.env` into the shell
> first is the fix.

| Service    | URL                            |
| ---------- | ------------------------------ |
| Web        | http://localhost:5173          |
| API        | http://localhost:3000          |
| API docs   | http://localhost:3000/api/docs |
| API health | http://localhost:3000/health   |
| Postgres   | localhost:5432                 |
| Redis      | localhost:6379                 |
| LocalStack | localhost:4566                 |

Open http://localhost:5173 and sign in. The recruiter console requires a `RECRUITER` or
`ADMIN` account.

### Seeded development accounts

| Email                             | Role           |
| --------------------------------- | -------------- |
| `admin@talentlens.local`          | ADMIN          |
| `recruiter@talentlens.local`      | RECRUITER      |
| `hiring.manager@talentlens.local` | HIRING_MANAGER |
| `candidate@talentlens.local`      | CANDIDATE      |

Password for all four: `DevPassword123!` — development only, set by
`apps/api/prisma/seed.ts`.

### What the seed creates

`prisma/seed.ts` writes a baseline plus a demo dataset. Every write is an upsert against
a fixed id or unique key, so **re-running it never duplicates a record**.

**Baseline** — what the API test suite depends on:

- 1 company, 4 users (one per role), 1 `ai_model_versions` row (`placeholder-v0`)
- 1 job — "Senior Backend Engineer", status `DRAFT`, fixed id
  `00000000-0000-0000-0000-000000000010`
- the 6 default pipeline stages for that job, and 1 job assignment

**Demo dataset** — so a fresh clone is demonstrable the moment the seed finishes:

- 1 job — **"Full-Stack Engineer"**, status **`PUBLISHED`**, with its own 6 stages and a
  hiring-manager assignment
- **8 candidates** and **8 applications**, spread across all six stages: Applied 2,
  Screening 2, Interview 1, Offer 1, Hired 1, Rejected 1
- **13 `stage_history` rows**, every one naming a human in `changed_by` — BR-01 allows no
  system-actor path to that table
- **6 scorecards** (ratings 2–5) and **3 comments**, all human-written text
- one application deliberately has no `source`, so RC-12 demonstrates FR7.3's
  `notRecorded` being kept distinct from `other`

The demo job's id is a **real v4 UUID**, which is load-bearing rather than cosmetic:
`SubmitApplicationDto` and `FunnelQueryDto` both validate with `@IsUUID('4')`, so the
baseline job's `…0010` id — version nibble `0` — is rejected by `POST /v1/applications`
and by the analytics job filter. This is the UUID inconsistency listed under
[current limitations](#deferred-screens-and-current-limitations).

### What the seed deliberately does not create

- **No `match_scores`.** No model is trained, so a seeded score would be a fabricated
  number wearing the authority of a computed one. `aiScoringEnabled` is `false` on both
  jobs, which is the FR4.5 unscored path the console already renders.
- **No `resumes` or `parsed_profiles`.** No parser runs. An `s3_key` with no object
  behind it in LocalStack is a broken link, and a parsed profile with no parser is the
  same fabrication as a score.
- **No `audit_logs`.** Those record what actually happened through the API; writing them
  here would forge an audit trail.

### Recruiter demo flow

After `prisma:migrate` and `prisma:seed` the console has meaningful data immediately —
no manual setup, no SQL. **RC-01, RC-02, RC-05, RC-06, RC-09, RC-10, RC-12 and RC-13**
are all populated; RC-03, RC-04 and RC-08 never depended on candidate data. RC-07, RC-11
and RC-14 remain unavailable for the backend reasons given under
[deferred screens](#deferred-screens-and-current-limitations) — the seed changes nothing
about them.

Optionally, to exercise the public intake path as well, submit a live application against
the **Full-Stack Engineer** job (its id is printed by RC-04's URL). `POST /v1/applications`
is `@Public()`, so no token is needed; `jobId`, `fullName` and `email` are required, and
`phone`, `source` and a `resume` file are optional:

```bash
curl -X POST http://localhost:3000/v1/applications \
  -H 'Content-Type: application/json' \
  -d '{"jobId":"<the v4 job id>","fullName":"Demo Candidate","email":"demo@example.com"}'
```

An attached resume is stored but **not parsed** — no parser runs in this build — so
`parseStatus` stays `PENDING` and no score is produced. That is the expected result, not
a failure.

The click path:

| Step | Screen                  | How you get there                                       |
| ---- | ----------------------- | ------------------------------------------------------- |
| 1    | Login (SC-01)           | http://localhost:5173 → `recruiter@talentlens.local`    |
| 2    | Dashboard (RC-01)       | Automatic — sign-in lands on `/dashboard`               |
| 3    | Job list (RC-02)        | Sidebar **Jobs**, or the dashboard's "View all jobs"    |
| 4    | Job detail (RC-04)      | Click a job title                                       |
| 5    | Candidates (RC-05/06)   | **Candidates** tab, or "View candidates"; click a name  |
| 6    | Scorecards (RC-13)      | On the candidate detail screen                          |
| 7    | Pipeline (RC-09/10)     | **Pipeline** tab; move a card, or multi-select for bulk |
| 8    | Ranking weights (RC-08) | **Ranking weights** tab                                 |
| 9    | Analytics (RC-12)       | Sidebar **Analytics**                                   |

Every step is reachable by clicking — no URL typing required. The sidebar shows
**Review queue** (RC-14) and **Interviews** (RC-11) as disabled entries marked "Later",
which is the honest presentation of their
[backend blockers](#deferred-screens-and-current-limitations).

### Running the apps separately

```bash
# API only (watch mode)
pnpm --filter @talentlens/api dev

# Web only — the Vite proxy expects the API on localhost:3000
pnpm --filter @talentlens/web dev
```

Both read the root `.env` through `ConfigModule`, so no extra environment setup is
needed. To run the compiled API instead of watch mode:

```bash
cd apps/api && set -a && . ../../.env && set +a && node dist/main.js
```

Every **Prisma CLI** command (`prisma:migrate`, `prisma:seed`, `prisma:studio`,
`prisma:deploy`) must be run from `apps/api` with `.env` exported — see the note under
[Setup](#setup).

---

## Environment variables

Copy `.env.example` to `.env`. That file carries the full reasoning for each variable;
this is the index.

| Variable                                                             | Purpose                                                                                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Postgres container                                                                                                                                                          |
| `DATABASE_URL`                                                       | **Owner** role — runs migrations, needs DDL rights                                                                                                                          |
| `APP_DATABASE_URL`                                                   | **Restricted** role the API connects as, so `audit_logs` stays append-only                                                                                                  |
| `REDIS_PORT`, `REDIS_URL`                                            | Session cache + BullMQ                                                                                                                                                      |
| `LOCALSTACK_PORT`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`           | Resume storage. In production `S3_ENDPOINT` is left unset                                                                                                                   |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                         | LocalStack accepts any non-empty pair; not secrets locally                                                                                                                  |
| `API_PORT`, `NODE_ENV`                                               | Core API                                                                                                                                                                    |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`                            | **Must differ** — the API refuses to start if they match                                                                                                                    |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`                                  | 15 min / 7 days                                                                                                                                                             |
| `SCHEDULING_TOKEN_SECRET`                                            | Signs candidate scheduling links. Falls back to `JWT_REFRESH_SECRET`; no TTL setting — a link expires when its last offered slot ends                                       |
| `CALENDAR_TOKEN_ENCRYPTION_KEY`                                      | Seals calendar refresh tokens at the application layer. **Required** to store a connection; no fallback, so a missing key fails loudly rather than downgrading to plaintext |
| `GOOGLE_CALENDAR_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`            | Google OAuth app. All three set = "configured"                                                                                                                              |
| `MICROSOFT_CALENDAR_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`         | Microsoft OAuth app                                                                                                                                                         |
| `MICROSOFT_CALENDAR_TENANT`                                          | `common` accepts any work or personal account                                                                                                                               |
| `VITE_API_BASE_URL`                                                  | Frontend API base                                                                                                                                                           |
| `AI_SERVICE_PORT`, `AI_SERVICE_URL`, `AI_SERVICE_TIMEOUT_MS`         | Python reference stub                                                                                                                                                       |
| `RESUME_WORKER_ENABLED`                                              | Opt-in: the worker holds a Redis connection and reaches an external process                                                                                                 |

Secrets are never committed (PRD §24.3). Calendar OAuth redirect URIs point at the
**frontend**, which forwards `code` + `state` to
`POST /v1/calendar/connections/:provider/complete` under the user's session — there is
no public callback endpoint.

---

## Build, test and verification commands

### Workspace scripts

| Command                        | Effect                           |
| ------------------------------ | -------------------------------- |
| `pnpm dev`                     | Run web and api together         |
| `pnpm build`                   | Build all packages and apps      |
| `pnpm lint` / `lint:fix`       | ESLint across the workspace      |
| `pnpm format` / `format:check` | Prettier write / check           |
| `pnpm typecheck`               | TypeScript across all packages   |
| `pnpm test`                    | All test suites                  |
| `pnpm infra:up` / `infra:down` | Start / stop the Docker services |

### API scripts (`pnpm --filter @talentlens/api …`)

| Command           | Effect                                               |
| ----------------- | ---------------------------------------------------- |
| `dev`             | `nest start --watch`                                 |
| `build` / `start` | `nest build` / `node dist/main.js`                   |
| `test`            | Jest — 43 spec files. `pretest` reseeds the database |
| `prisma:migrate`  | `prisma migrate dev` (local)                         |
| `prisma:deploy`   | `prisma migrate deploy` (CI / production)            |
| `prisma:seed`     | Seed demo data                                       |
| `prisma:studio`   | Browse the database                                  |

The API test suite needs Postgres and Redis running **and `.env` exported**, because
`pretest` runs `prisma db seed`:

```bash
cd apps/api && set -a && . ../../.env && set +a && pnpm test
```

### Verification used for this build

```bash
cd apps/web && npx tsc -b   # TypeScript project references — there is no root tsconfig
npx eslint apps/web         # Frontend lint (from the repository root)
npx prettier --check .      # Formatting (from the repository root)
cd apps/web && npx vite build  # Production frontend build
git diff --check            # No whitespace errors in the diff
```

`tsc -b` and `vite build` must be run from `apps/web`; there is no root `tsconfig.json`,
so `npx tsc -b` at the repository root fails with `TS5083`.

A scripted end-to-end browser pass covers signed-out redirects on all routes, role
denial for `HIRING_MANAGER` and `CANDIDATE`, deep-link reload on every screen, 404 and
error states, loading states, and an assertion that read-only screens issue no writes.

---

## Rules this codebase enforces

From PRD §13. These are constraints on implementation, not features:

- **BR-01** No candidate is rejected by AI. Terminal stage changes require a human actor.
- **BR-02** No score without a rationale — enforced at the database level.
- **BR-03** Every override is audited with a reason, written before the response returns.
- **BR-04** Only Administrators toggle AI scoring per job.
- **BR-05** Candidate data is purpose-limited and erasable.
- **BR-06** Role-restricted PII; foreign records return 404, never 403.
- **BR-07** No protected attribute is ever a model input — a fixed six-feature
  allow-list (`feature-allow-list.ts`) is the enforcement point.

---

## Phase status

| Phase  | Scope                                                     | Status                  |
| ------ | --------------------------------------------------------- | ----------------------- |
| P1     | Requirements & UX design                                  | ✅ Complete             |
| P2     | Core platform — jobs, applications, pipeline, RBAC, audit | ✅ Complete (M2.10)     |
| **P3** | **AI screening — parsing, ranking, explainability**       | **◑ Integration only**  |
| P4     | QA, accessibility, fairness testing                       | ⛔ Blocked on P3 models |
| P5     | Beta                                                      | ⏳                      |
| P6     | General availability                                      | ⏳                      |

Recruiter console: 11 of 14 specified screens implemented. RC-07, RC-11 and RC-14 are
deferred on backend capability, as detailed above.
