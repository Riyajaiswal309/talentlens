# TalentLens — Demo & Viva Preparation

Riya Jaiswal · B.Tech CSE final year · GD Goenka University · 2026–27

> **How to use this file.** Everything here is drawn from the actual repository at commit
> `675299e`. Nothing is aspirational. If a sentence is not in this document, do not claim
> it in the viva — especially anything about AI scoring or resume parsing, neither of
> which runs in this build. Section 8 lists exactly what not to claim.

---

## Contents

1. [The 2-minute explanation](#1-the-2-minute-explanation)
2. [Architecture](#2-architecture)
3. [Technology stack — and why](#3-technology-stack--and-why)
4. [Recruiter demo script (click-by-click)](#4-recruiter-demo-script-click-by-click)
5. [The seeded demo data](#5-the-seeded-demo-data)
6. [30 likely viva questions](#6-30-likely-viva-questions)
7. [15 difficult questions, answered honestly](#7-15-difficult-questions-answered-honestly)
8. [Implemented / partial / limitations / do-not-claim](#8-implemented--partial--limitations--do-not-claim)
9. [5-minute presentation script](#9-5-minute-presentation-script)
10. [10-minute live demo script](#10-10-minute-live-demo-script)

---

## 1. The 2-minute explanation

### The problem

One open job can attract hundreds of applications. A recruiter then has to do three jobs
at once: read every resume, remember which candidate is at which stage, and coordinate
interviewers' calendars. Two things go wrong.

**Volume beats attention.** Screening becomes inconsistent — it depends on whether a
resume was read at 9 a.m. or at 6 p.m. Good candidates get missed, and afterwards there
is no record of _why_ anyone was moved forward.

**Automation gets trusted blindly.** The usual fix is a keyword filter or an opaque
"match score". But a score with no explanation cannot be argued with, and a system that
auto-rejects has quietly made a hiring decision that no human can account for.

So an Applicant Tracking System has to solve a _governance_ problem, not just a speed
problem: make screening faster **and** keep every decision traceable to a human.

### What TalentLens does

TalentLens is a multi-tenant Applicant Tracking System with a working recruiter console.
A recruiter can:

- create, publish, edit and close job requisitions
- receive applications through a public endpoint
- see every candidate for a job and open a full application record
- move candidates through a six-stage pipeline, one at a time or in bulk
- write structured 1–5 scorecards and threaded comments
- configure the ranking weights that a scoring model _would_ use
- read a conversion funnel with drop-off, time-in-stage and time-to-hire

The design rule running through all of it: **the system ranks and explains, a human
decides.** Scoring is advisory only, a score can never exist without a stored rationale,
no automated path can reject anyone, and every consequential write is audited.

### Who uses it

Four roles, defined in `packages/shared-types`:

| Role               | What they do                                                                         |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Recruiter**      | The main user. Owns requisitions, candidates, pipeline, scorecards, analytics        |
| **Hiring Manager** | Reviews candidates on the jobs they are _assigned to_ — not all jobs                 |
| **Administrator**  | Everything a recruiter can do, plus the AI toggle, user management and the audit log |
| **Candidate**      | Applies through the public endpoint; can only ever reach their own application       |

### Main benefits

- **One place** for requisitions, candidates, stages, feedback and reporting
- **Consistency** — every candidate goes through the same six stages with the same 1–5 scorecard
- **Accountability** — stage moves and overrides are recorded against a named human
- **Fairness by construction** — ranking can only ever use six named features; protected
  attributes are structurally excluded, not merely discouraged
- **Honesty** — where the system has no data, the screen says so instead of showing a zero

---

## 2. Architecture

### The big picture

```
Browser (React 18 + Vite, port 5173)
        │
        │  root-relative /v1/... requests, same-origin via the Vite dev proxy
        ▼
NestJS API (port 3000, global prefix /v1)
        │  guards → controller → DTO validation → service → Prisma
        ▼
PostgreSQL 15   +   Redis 7 (BullMQ queue)   +   S3 / LocalStack (resume files)
        │
        ▼ (opt-in, OFF by default)
Python FastAPI "AI service" — a reference STUB, not a trained model
```

### Frontend — `apps/web`

React 18 with Vite, TypeScript in strict mode (`noUncheckedIndexedAccess`,
`noUnusedLocals`, `noUnusedParameters`). Organised by feature:

```
src/
├── main.tsx        QueryClientProvider > BrowserRouter > AuthProvider > App
├── App.tsx         Routes, nested RequireAuth > RequireRole > RecruiterLayout
├── lib/            api-client.ts (fetch wrapper), problem-details.ts (RFC 7807 → ApiError)
├── auth/           session.ts, AuthContext, RequireAuth, RequireRole
├── layouts/        RecruiterLayout (sidebar), navigation.ts, Breadcrumbs
├── components/     Skeleton/LoadingState, EmptyState, ErrorState
└── features/       auth · jobs · candidates · pipeline · analytics · dashboard
```

Three points worth knowing:

- **There is no client-side state store.** All server state lives in TanStack Query. There
  is no Redux, no Zustand, no Context for data.
- **The Vite dev proxy (`/v1 → localhost:3000`) is mandatory, not a convenience.** The API
  never calls `app.enableCors()`, and the refresh cookie is `SameSite=Strict` — so a
  cross-origin frontend could not send it even if CORS were open. Same-origin is the only
  configuration in which the session works.
- **Four shared state components** cover what every data screen must express: loading
  (skeletons with `role="status"`/`aria-busy`), empty, error, and skeleton primitives.

### Backend — `apps/api`

NestJS 10, modular. **23 controllers, 48 HTTP route handlers**, all under `/v1`, with
Swagger at `/api/docs`. `GET /health` sits _outside_ the prefix so a container probe can
reach it unauthenticated.

Modules: `auth`, `jobs` (+ `public-jobs`), `applications` (+ `job-candidates`),
`pipeline`, `scorecards` (+ `comments`, `reviews`), `interviews` (+ `scheduling`,
`availability`), `calendar`, `analytics`, `ai` (`ranking-weights`, `score-override`,
`parse-review`), `admin`, `audit`, `health`.

**Every error is RFC 7807** `application/problem+json`:

```json
{
  "type": "...",
  "title": "Not found",
  "status": 404,
  "detail": "...",
  "instance": "/v1/jobs/...",
  "correlationId": "..."
}
```

The frontend has no ad-hoc error handling as a result — one `ApiError` class parses this
shape and every screen renders from it.

**Validation is whitelist-only.** The global `ValidationPipe` runs with
`forbidNonWhitelisted`, so an undeclared query parameter is a `400`, never a silently
ignored filter. This is _why_ the candidate list ships without search/stage filters — the
DTO accepts only `cursor` and `limit`, so inventing a parameter would just produce errors.

### Database — PostgreSQL 15

**19 Prisma models, 10 migrations.** The main ones:

```
Company ──< Users
   │           │
   └──< Job ──< JobAssignment      (which HM can see which job)
         ├──< PipelineStage        (per-job, NOT a global enum)
         └──< Application ──< StageHistory
                   │        ├──< Scorecard
                   │        ├──< Comment
                   │        ├──< Resume ──< ParsedProfile
                   │        ├──< MatchScore
                   │        └──< Interview
                   └── Candidate
```

Three deliberate design decisions you should be able to defend:

1. **`Application.currentStage` is a string, not a foreign key.** Stages are _per-job
   configurable data_, so the column stores the stage's name, matching `stage_history`.
2. **Pipeline stages are rows, not an enum**, because the requirement is that each job may
   configure its own stages.
3. **Three constraints are raw SQL in the migration** because Prisma's schema language
   cannot express them: a `CHECK` on the score range, a _partial_ index on
   `resumes(parse_status)`, and `REVOKE UPDATE, DELETE ON audit_logs`.

**Two database roles.** `DATABASE_URL` is the owner and runs migrations;
`APP_DATABASE_URL` is a restricted role the API connects as at runtime. This matters: in
PostgreSQL a table _owner bypasses REVOKE_, so `audit_logs` is only genuinely append-only
if the application is not the owner.

### Authentication and RBAC

| Token         | Lifetime   | Stored                                                            |
| ------------- | ---------- | ----------------------------------------------------------------- |
| Access token  | 15 minutes | **In memory only** — never `localStorage`, never `sessionStorage` |
| Refresh token | 7 days     | httpOnly cookie, `Path=/v1/auth`, `SameSite=Strict`               |

- **Passwords** are hashed with **Argon2id** (memory 19456, time 2, parallelism 1).
- **The refresh token rotates on every use and is single-use.** Each one carries a `jti`
  that is consumed on exchange.
- **Replay is detected.** If a `jti` that has already been consumed is presented again,
  the API treats it as a stolen token and **revokes every live token for that user**,
  forcing re-authentication.
- **The two JWT secrets must differ** — the API refuses to start if they match, because a
  shared secret would let an access token be replayed as a refresh token.
- **Single-flight refresh on the client.** On reload several queries 401 at once; since
  the refresh token is single-use, three parallel refreshes would mean one success and two
  failures — a silent logout. `auth/session.ts` holds one shared in-flight promise that
  all callers await. Verified against the live API: 3 concurrent refreshes → 1×200, 2×401.

**Guard order** (from `main.ts`):

```
JwtAuthGuard → RolesGuard → TenantGuard → JobAssignmentGuard → CandidateOwnershipGuard
```

Be precise about what each does, because this is a favourite viva trap:

- `RolesGuard` checks the `@Roles(...)` decorator on the controller.
- `TenantGuard` asserts the authenticated request **carries** a `companyId` (403 if not).
  It does **not** do row filtering.
- **Row-level tenant scoping lives in the services**, as `where: { id, companyId }` on
  every query, throwing `NotFoundException` when nothing matches.
- `JobAssignmentGuard` narrows a Hiring Manager to assigned jobs, refusing with **404**.
- `CandidateOwnershipGuard` restricts a candidate to their own applications.

On the client, `RequireAuth` redirects to `/login` (remembering the intended
destination) and `RequireRole` allows only `RECRUITER` and `ADMIN` into the console. This
is a **usability layer, not the security boundary** — the server is the boundary.

### API structure

Conventions that hold across the whole API:

- **Cursor pagination** (`{ data, nextCursor }`), forward-only, **no totals**. This is why
  the UI says "8 loaded" and never "8 of 147".
- **RFC 7807** on every error, with a `correlationId`.
- **404, never 403, for a record in another tenant** — a 403 would confirm the id exists,
  which is itself a cross-tenant leak.

### AI service and its limitations — read carefully

`apps/ai-service` is a **Python FastAPI reference stub**. Its own health endpoint reports
`"model": "reference-stub (NOT TRAINED, NOT VALIDATED)"` and its version tag is
`reference-stub@not-trained-v0`. It computes deterministic pseudo-values from a hash of
its inputs. **It is not a model. It has not been trained. It has not been validated.**

The _plumbing_ around it exists — a BullMQ queue, a worker, the `parsed_profiles` and
`match_scores` tables, ranking weights, a parse-review endpoint. But:

- The worker is **opt-in** (`RESUME_WORKER_ENABLED`, default `false`)
- **No resume parser runs.** `parsed_profiles` is empty, `parseStatus` stays `PENDING`
- `aiScoringEnabled` is **false** on every job, so the console renders its unscored variant
- **No `match_scores` exist in the demo tenant**

Why no model? The PRD requires consent-gated historical application data, recruiter
accept/reject/hire labels, a licensed resume corpus, a human-verified golden NER dataset
and an access-restricted fairness dataset. None of that exists for a student project, so
the promotion gates cannot be evaluated and the fairness gate has no override path.
Shipping a stub and saying so is the correct engineering answer.

### How data flows: frontend → backend → database

Take **moving a candidate from Screening to Interview**:

1. **UI** — recruiter opens the "Move to…" menu on a card in `PipelineBoard` and picks
   "Interview".
2. **Optimistic update** — TanStack Query immediately moves the card and snapshots the old
   state, so the board feels instant.
3. **Request** — `api.patch('/applications/<id>/stage', { toStage: 'Interview' })`. The
   client attaches the in-memory access token; the Vite proxy makes it same-origin.
4. **Guards** — `JwtAuthGuard` validates the token → `RolesGuard` checks the role →
   `TenantGuard` confirms a tenant is present.
5. **Validation** — `ChangeStageDto` checks `toStage` is a non-empty string ≤ 100 chars.
   Anything undeclared in the body is rejected by `forbidNonWhitelisted`.
6. **Service** — loads the application scoped by `job: { companyId: user.companyId }`. If
   it belongs to another tenant, the query returns nothing and the service throws **404**.
   It checks the target stage exists on that job, and if the stage is terminal it requires
   explicit human confirmation (BR-01).
7. **Database, in one transaction** — update `applications.current_stage`, insert a
   `stage_history` row with `changed_by` set to the real user, and append an `audit_logs`
   row.
8. **Response** — the updated application, or an RFC 7807 problem document.
9. **UI settles** — on success the query is invalidated and refetched; **on failure the
   optimistic change is rolled back** to the snapshot and an `ErrorState` shows the
   server's own message.

---

## 3. Technology stack — and why

Answer "why" from the repository, not from generic advantages.

| Technology                        | Why it is used here                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript 5.7 (strict)**       | The API contract is the risky boundary in this project. Strict mode with `noUncheckedIndexedAccess` catches "the array might be empty" bugs at compile time. Types are shared between web and api via `packages/shared-types`, so a role name cannot drift between the two.                          |
| **pnpm workspaces**               | One repository holding `apps/web`, `apps/api`, `apps/ai-service` and `packages/shared-types`. pnpm's content-addressed store avoids duplicating dependencies across three apps.                                                                                                                      |
| **NestJS 10**                     | The whole security model is layered — authenticate, then role, then tenant, then per-record. Nest's guard pipeline expresses that ordering _declaratively_ in one place. Its DI also made the AI boundary swappable: `AiScoringPort` is an interface with a null implementation and a persisted one. |
| **Prisma 6**                      | Type-safe queries generated from one schema file, so a column rename becomes a compile error rather than a runtime crash. Migrations are versioned files, and the three constraints Prisma cannot express are appended as raw SQL.                                                                   |
| **PostgreSQL 15**                 | Needed for things a document store would make hard: transactional stage-change + history + audit writes, a `jsonb` column with a GIN index for required skills, partial indexes, and `REVOKE` to make `audit_logs` append-only at the database level.                                                |
| **Redis 7 + BullMQ**              | Resume parsing is slow and must not block a candidate's submission (the requirement is that submission succeeds independently of parsing). A queue decouples them. Redis also backs the refresh-token store used for rotation and revocation.                                                        |
| **S3 / LocalStack**               | Resume files do not belong in a relational database. LocalStack gives the same S3 API locally, so no code differs between local and deployed.                                                                                                                                                        |
| **Argon2id**                      | The current OWASP recommendation for password hashing — memory-hard, so GPU cracking is expensive. Parameters are tuned in the code, not left at defaults.                                                                                                                                           |
| **JWT + rotating refresh cookie** | A short-lived access token limits the damage of a leak; the httpOnly refresh cookie cannot be read by JavaScript at all. Rotation plus reuse-detection means a stolen token is _detectable_, not just short-lived.                                                                                   |
| **React 18**                      | A recruiter console is a set of interactive stateful screens; the component model plus the ecosystem fits.                                                                                                                                                                                           |
| **Vite 5**                        | Instant dev server start and HMR, and — critically — the dev **proxy**, which is what makes the same-origin cookie model work without touching the backend.                                                                                                                                          |
| **TanStack Query v5**             | Almost all state here is _server_ state: lists, one record, cache invalidation after a mutation, cursor pagination, optimistic updates with rollback. Query does this natively, which is why the app needs no Redux at all.                                                                          |
| **React Router**                  | Deep links carry ids (`/jobs/:jobId/candidates/:applicationId`), which must survive a reload and drive the guards.                                                                                                                                                                                   |
| **Tailwind CSS 3**                | The design system is a fixed token set (neutral/primary/success/warning/danger/info, radii 4/8/12). Tailwind encodes those tokens in config so a component cannot invent an off-palette colour.                                                                                                      |
| **Jest + supertest**              | 43 spec files, 814 tests, most hitting a real database rather than mocks — appropriate when the rules under test are transactional and constraint-based.                                                                                                                                             |
| **FastAPI (Python)**              | The language ML would actually be written in, so the seam is realistic. Today it serves a stub.                                                                                                                                                                                                      |
| **Docker Compose**                | One command brings up Postgres, Redis and LocalStack at pinned versions, so a fresh clone reproduces the environment.                                                                                                                                                                                |

**Deliberately absent from the frontend**, and you should say so proudly: no charting
library (the funnel bars are CSS), no drag-and-drop library (stage moves use a
keyboard-operable menu, because drag-only fails WCAG 2.1.1), no component library, no
state-management library.

---

## 4. Recruiter demo script (click-by-click)

Start the stack first:

```bash
docker compose up -d postgres redis      # infrastructure
pnpm dev                                 # web on :5173, api on :3000
```

> **Numbers you will see.** A fresh clone seeds **2 jobs and 8 applications**. If you demo
> on the laptop you developed on, the totals will be slightly higher (extra jobs and one
> extra application left over from testing). Say "eight seeded applicants on this job" —
> that is true in both cases.

| #   | Screen                       | Exactly what to click                                                                                                          | What is on screen                                                                                                                                                                           |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Landing page**             | Go to `http://localhost:5173` — this is the public marketing page, not the app                                                 | Hero, eight feature cards, governance section. Note that AI-assisted scoring is labelled "model not trained"                                                                                |
| 1   | **Login (SC-01)**            | Click **Get started** (or **Sign in**) in the navbar. Type `recruiter@talentlens.local` / `DevPassword123!`. Click **Sign in** | Redirects automatically to `/dashboard`                                                                                                                                                     |
| 2   | **Dashboard (RC-01)**        | Nothing — just read it                                                                                                         | Tiles: Open requisitions, Applications, Hired, and **Awaiting review "—"**. Below: a funnel snapshot and the jobs table                                                                     |
| 3   | **Jobs (RC-02)**             | Click **Jobs** in the left sidebar                                                                                             | The job list. Point out the **Status** dropdown and the **Department** filter                                                                                                               |
| 4   | **Job detail (RC-04)**       | Click **Full-Stack Engineer**                                                                                                  | Title, status, department, location, required skills, description; tabs Overview / Candidates / Pipeline / Ranking weights; Edit and Close buttons                                          |
| 5   | **Candidates (RC-05)**       | Click the **Candidates** tab                                                                                                   | 8 candidates, newest first. Heading reads **"Candidates 8 loaded"**. A blue notice says AI scoring is disabled for this job — **and there is no score column at all**                       |
| 6   | **Candidate detail (RC-06)** | Click **Mei Lin Chen**                                                                                                         | Her application record, current stage Interview, the comment thread, and her scorecards                                                                                                     |
| 7   | **Scorecards (RC-13)**       | Stay on the same screen and scroll to Scorecards                                                                               | **Two** scorecards — one from the recruiter, one from the hiring manager, both 4/5 with written feedback. Open the form to show the 1–5 radio group                                         |
| 8   | **Pipeline (RC-09)**         | Go back to the job → click the **Pipeline** tab                                                                                | Six columns: Applied 2, Screening 2, Interview 1, Offer 1, Hired 1 (Final), Rejected 1 (Final). Click **Move to…** on a card to show the menu — _you do not have to complete the move_      |
| 9   | **Bulk actions (RC-10)**     | Tick the checkbox on two cards in the same column                                                                              | A bar appears: "2 candidates selected", with a stage picker and Clear                                                                                                                       |
| 10  | **Ranking weights (RC-08)**  | Click the **Ranking weights** tab                                                                                              | Six sliders — the only six features permitted. Live total reads **1.0000 / 1.0000**. Drag one slider to break the total and show Save disable itself                                        |
| 11  | **Analytics (RC-12)**        | Click **Analytics** in the sidebar                                                                                             | Funnel table with reached / currently-here / conversion / median time; **Time to hire** (1 hired, median 24 d); and source of hire, which reports **"8 of 9 recorded a source, 1 did not"** |

**Two honest moments to plan for** — they are strengths, not gaps:

- On RC-05, say: _"There is no score column, and that is deliberate. AI scoring is off for
  this job, and the requirement is that the column is removed entirely rather than greyed
  out, so an unscored list can never be mistaken for a scored list that failed to load."_
- On RC-01, point at **Awaiting review "—"**: _"That dash is honest. There is no endpoint
  that gives a cross-job review count, so rather than print a zero that looks like real
  information, the screen says the number doesn't exist yet."_

---

## 5. The seeded demo data

`apps/api/prisma/seed.ts` is **idempotent** — every write is an upsert against a fixed id
or unique key, so running it twice changes nothing.

### Baseline (what the test suite needs)

- 1 company, 4 users (one per role), all with password `DevPassword123!`
- 1 `ai_model_versions` row, `placeholder-v0`, status **inactive**
- 1 job — "Senior Backend Engineer", **DRAFT**, id `00000000-0000-0000-0000-000000000010`
- the 6 default pipeline stages for it, and 1 job assignment

### Demo dataset

**Job:** "Full-Stack Engineer" — **PUBLISHED**, `aiScoringEnabled: false`, with its own six
stages and a hiring-manager assignment. Its id is a **real v4 UUID**, which matters:
`SubmitApplicationDto` and `FunnelQueryDto` both validate with `@IsUUID('4')`, so the
baseline job's `…0010` id is actually rejected by `POST /v1/applications`.

**8 candidates and 8 applications:**

| Candidate      | Stage        | Source         | Scorecards                    | Comments |
| -------------- | ------------ | -------------- | ----------------------------- | -------- |
| Priya Nair     | Applied      | career_site    | —                             | —        |
| Arjun Mehta    | Applied      | job_board      | —                             | —        |
| Sara Iqbal     | Screening    | referral       | —                             | 1        |
| Daniel Okafor  | Screening    | career_site    | 1 (3/5)                       | —        |
| Mei Lin Chen   | Interview    | career_site    | **2** (4/5 recruiter, 4/5 HM) | 1        |
| Tomás Rivera   | Offer        | referral       | 1 (5/5 HM)                    | 1        |
| Aisha Rahman   | **Hired**    | job_board      | 1 (5/5)                       | —        |
| Victor Adeyemi | **Rejected** | _not recorded_ | 1 (2/5)                       | —        |

**Pipeline stages:** the six PRD defaults — Applied, Screening, Interview, Offer, Hired,
Rejected. The last two are marked terminal.

**Stage history:** 13 rows. Every one names a real seeded human in `changed_by`, because
BR-01 permits no system-actor path to that table. Note that an application's _first_ stage
has no history row — history is written on transition, and creation is not a transition.

**Scorecards:** 6, ratings from 2 to 5, all with written feedback. Mei Lin Chen has two,
from different authors, which demonstrates the `@@unique(applicationId, authorId)`
constraint — one scorecard per person per candidate.

**Comments:** 3, on Sara, Mei Lin and Tomás.

**Analytics this produces:** a funnel with genuine drop-off (8 reached Applied, 6
Screening, 3 Interview, 2 Offer, 1 Hired, 1 Rejected), real median time-in-stage, a
computable **time to hire of 24 days** (Aisha applied 45 days ago, hired 21 days ago), and
a source-of-hire breakdown where one application is deliberately unrecorded.

### What is intentionally NOT seeded, and why

| Not seeded        | Why                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `match_scores`    | No model is trained. A seeded score would be a fabricated number wearing the authority of a computed one |
| `resumes`         | An `s3_key` with no object behind it in LocalStack is just a broken download link                        |
| `parsed_profiles` | No parser runs. A parsed profile with no parser is the same fabrication as a score                       |
| `audit_logs`      | Those record what actually happened through the API. Writing them in a seed would forge an audit trail   |

If asked why the demo data looks "small": it is deliberately the _minimum_ that makes
every implemented screen meaningful. Eight applicants is enough to show real drop-off in
the funnel, occupied columns on the board, and multi-select in bulk actions — one
applicant would make all three technically non-empty but practically undemonstrable.

---

## 6. 30 likely viva questions

**Architecture**

1. **What architecture does TalentLens use?**
   A monorepo with a React single-page frontend, a NestJS REST API, PostgreSQL for data,
   Redis for queueing and refresh tokens, S3 for files, and a separate Python service for
   AI. The frontend never touches the database — everything goes through the API.

2. **Why separate the AI service instead of putting it in the API?**
   Different language and different lifecycle. ML is written in Python, and a model is
   retrained and redeployed on its own schedule. Keeping it behind an HTTP boundary means
   the API depends on an interface, not on a model.

3. **What happens if the AI service is down?**
   Nothing breaks. Scoring is advisory, the worker is off by default, and the API binds an
   `AiScoringPort` whose null implementation simply reports "not scored".

4. **How does the frontend talk to the backend?**
   Root-relative `/v1/...` fetch calls through a small wrapper, proxied by Vite to port
   3000 so the browser sees one origin.

5. **Why is the Vite proxy mandatory?**
   The API never enables CORS, and the refresh cookie is `SameSite=Strict`, so the browser
   would refuse to send it cross-site regardless. Same-origin is the only working setup.

**Database**

6. **How many tables, and how are they migrated?**
   19 Prisma models across 10 versioned migrations, applied with `prisma migrate`.

7. **Why is `current_stage` a string and not a foreign key?**
   Stages are configurable per job, so the column stores the stage name, which also keeps
   it consistent with `stage_history`.

8. **How is the audit log made append-only?**
   `REVOKE UPDATE, DELETE ON audit_logs` in the migration, and the API connects as a
   _restricted_ role — because in PostgreSQL the table owner would bypass the revoke.

9. **How do you store required skills?**
   A `jsonb` column with a GIN index, so skill lookups are indexed rather than scanned.

10. **What does soft delete mean here?**
    A candidate has `deleted_at` and `erased_by`. Erasure overwrites the personal fields
    but keeps applications, stage history and the audit trail — so _what happened_ stays
    reconstructable even though _who it happened to_ does not.

**APIs**

11. **How is the API versioned?**
    A global `/v1` prefix, with `/health` deliberately excluded so probes can reach it.

12. **What does an error look like?**
    RFC 7807 `application/problem+json` with `type`, `title`, `status`, `detail`,
    `instance` and a `correlationId` for tracing.

13. **How is pagination done?**
    Cursor-based: the response is `{ data, nextCursor }` where the cursor is the last
    row's id. Forward-only, and it returns no total — which is why the UI says "8 loaded".

14. **What stops a client sending an unexpected field?**
    The global `ValidationPipe` with `forbidNonWhitelisted` — an undeclared property is a
    400, not silently ignored.

15. **Where is the API documented?**
    Swagger/OpenAPI at `http://localhost:3000/api/docs`.

**Authentication**

16. **How does login work?**
    Email and password, verified against an Argon2id hash. The response carries a 15-minute
    access token, and a 7-day refresh token is set as an httpOnly cookie.

17. **Where is the access token stored, and why?**
    In memory only — never `localStorage` or `sessionStorage`, so an XSS payload cannot
    read it. The cost is that a page reload starts tokenless and must refresh.

18. **What makes the refresh token safe?**
    It is httpOnly, `SameSite=Strict`, scoped to `Path=/v1/auth`, rotated on every use and
    single-use. Presenting a consumed one is treated as theft and revokes all that user's
    live tokens.

19. **Why must the two JWT secrets differ?**
    Otherwise an access token could be replayed as a refresh token. The API refuses to
    start if they match.

20. **What is single-flight refresh?**
    On reload, several requests 401 simultaneously. Because refresh is single-use, parallel
    refreshes would log the user out. The client shares one in-flight refresh promise.

**RBAC and multi-tenancy**

21. **What are the roles?**
    Administrator, Recruiter, Hiring Manager, Candidate.

22. **How is role access enforced?**
    `@Roles(...)` on controllers, checked by `RolesGuard` on the server. The frontend's
    `RequireRole` is only a usability layer.

23. **How is tenant isolation enforced?**
    `TenantGuard` asserts the request carries a `companyId`, and **every service query
    filters by it** — for example `where: { id, companyId }`. Applications reach tenancy
    through their job.

24. **Why 404 instead of 403 for another tenant's record?**
    A 403 confirms the id exists, which leaks information — you could enumerate a
    competitor's job ids from status codes alone.

25. **Why is the candidates table not tenant-scoped?**
    A person applies through a public endpoint before any company relationship exists, so
    the profile cannot belong to a company. Isolation is enforced at the application level.

**Frontend / Prisma / testing**

26. **Why no Redux?**
    Nearly all state is server state, and TanStack Query already handles caching,
    invalidation, pagination and optimistic updates.

27. **What is an optimistic update here?**
    Moving a pipeline card updates the UI immediately and snapshots the old state; if the
    request fails, the snapshot is restored and the error is shown.

28. **What does Prisma give you?**
    A single schema file generating a fully typed client, plus versioned migrations, so a
    column change surfaces as a compile error.

29. **How is the project tested?**
    43 Jest spec files, 814 tests, mostly integration tests against a real PostgreSQL —
    appropriate because the rules being tested are transactional and constraint-based.

30. **What are the business rules the code enforces?**
    BR-01 no AI rejection; BR-02 no score without a rationale; BR-03 overrides audited with
    a reason; BR-04 admin-only AI toggle; BR-05 erasure; BR-06 404 not 403; BR-07 a fixed
    six-feature allow-list so no protected attribute can be a model input.

---

## 7. 15 difficult questions, answered honestly

> The rule for all of these: **concede the limitation first, then show the engineering
> judgement behind it.** Every one of these has a genuine answer — none needs bluffing.

1. **"You call this AI-powered, but nothing is trained. Isn't the title misleading?"**
   Fair challenge. The AI _integration_ is built end to end — queue, worker, the tables,
   ranking weights, the scoring port — but no model is trained, and the service says so in
   its own health response: `reference-stub (NOT TRAINED, NOT VALIDATED)`. Training needs
   consent-gated historical applications, hiring outcome labels, a licensed resume corpus
   and a fairness dataset, none of which a student project can lawfully obtain. I judged
   that shipping a stub and labelling it honestly is better engineering than shipping a
   number I cannot defend.

2. **"Then what is actually AI about this project?"**
   The architecture and the governance. The seam where a model plugs in is real and typed;
   the six-feature allow-list that constrains what a model may ever see is enforced in
   code; the rule that a score cannot exist without a rationale is a NOT NULL column. Those
   are the parts that are hard to retrofit — the model itself is replaceable.

3. **"Show me resume parsing."**
   I can't — no parser runs. The upload path, the `resumes` table, the `parsed_profiles`
   table and the queue exist, but `parse_status` stays `PENDING`. That is also exactly why
   the Parse Review screen (RC-14) is not implemented: it would list nothing.

4. **"Three of your fourteen screens are missing. Why?"**
   Each is blocked on a backend capability, not on frontend effort. RC-07 Score Override
   has no scores to override and no `override_score` column. RC-11 Interviews has no
   recruiter-readable interviewer list — the only user listing is admin-only. RC-14 has no
   parser and no cross-job parse-review endpoint. I chose to leave them out and say why,
   rather than build screens that would need fake data to look alive.

5. **"Your candidate list has no search or filters. Isn't that a basic feature?"**
   It is, and the API cannot serve it: `ListJobCandidatesQueryDto` accepts only `cursor`
   and `limit`, and because validation runs with `forbidNonWhitelisted`, inventing a
   parameter would produce a 400. Adding a filter that silently did nothing would be worse
   than not having one.

6. **"Why can't you show a total candidate count?"**
   Cursor pagination never counts the full set, and no endpoint returns a total. So the UI
   says "8 loaded", which is a true statement, rather than implying a total it doesn't have.

7. **"Your seeded data is tiny. Would this scale?"**
   The dataset is small on purpose — it is the minimum that makes each screen meaningful.
   Scale is addressed structurally: cursor pagination instead of OFFSET, a composite index
   on `(job_id, current_stage)` for the board, a GIN index on skills, and bulk operations
   capped at 100. What I have not done is load-test it, so I won't claim a throughput
   figure.

8. **"You seeded stage history. Isn't that fabricating an audit trail?"**
   Stage history is operational data — who moved whom, when — and every seeded row names a
   real seeded user, which is what BR-01 requires. I deliberately did **not** seed
   `audit_logs`, because those represent actual API calls, and manufacturing them would be
   forging evidence. That line was the whole point.

9. **"Why is `TenantGuard` not doing the filtering? Isn't that a hole?"**
   The guard asserts a precondition — the request is scoped to a tenant. The actual
   filtering is in every service query, because row-level scoping needs the query context
   the guard doesn't have. If you want to criticise it, the fair criticism is that this
   relies on discipline in every service rather than one choke point; the mitigation is
   that it is covered by integration tests, including cross-tenant tests.

10. **"What if a developer forgets the `companyId` filter in a new query?"**
    That is the real risk of the current design, and I won't pretend otherwise. Today it is
    caught by code review and by authorization integration tests that assert 404 across
    tenants. A stronger answer would be PostgreSQL row-level security or a Prisma
    middleware that refuses an unscoped query — that is what I would do next.

11. **"You have 814 tests but none for the frontend. Why?"**
    Correct — `apps/web` has a placeholder test script. The frontend was verified by strict
    typecheck, lint, production build, and scripted browser passes covering RBAC, deep-link
    reloads, error and loading states. That is weaker than a component test suite, and it
    is the clearest gap in the project.

12. **"Your UUID validation is inconsistent — DTOs use v4, params use any UUID."**
    True, and documented. A non-v4 UUID is accepted by one and rejected by the other, which
    is why the baseline seeded job cannot receive an application. I chose not to fix it
    late in the project because it changes the API contract; instead the demo job uses a
    genuine v4 id so the path a grader follows works.

13. **"Why is there no drag-and-drop on the Kanban board?"**
    Deliberate. Drag-only interaction fails WCAG 2.1.1 keyboard operability, which the
    non-functional requirements demand. The board uses a keyboard-reachable "Move to…"
    menu. It also avoids a dependency for a behaviour I would have had to make accessible
    anyway.

14. **"Is this production-ready?"**
    No, and I would not deploy it as-is. Missing: a trained model, frontend tests, load
    testing, real object storage and secrets management, and the row-level-security
    hardening in question 10. What _is_ production-shaped is the security model, the audit
    trail, the migration discipline and the error contract.

15. **"What is the single weakest part of your project?"**
    The absence of a trained model, because it is the part the title promises. The second
    is the lack of frontend tests. I would rather state both plainly than have you find
    them — and I can explain precisely what would be needed to close each.

---

## 8. Implemented / partial / limitations / do-not-claim

### Fully implemented

- Authentication: login, logout, rotating single-use refresh with reuse detection, Argon2id
- RBAC across four roles, enforced server-side, with recruiter/admin console gating
- Multi-tenant isolation with 404-not-403 semantics
- Job requisitions: list (department + status filters, cursor pagination), create, edit,
  publish, close, duplicate
- Public application submission endpoint
- Candidate list and full application detail
- Pipeline: six configurable stages, single and bulk stage moves, optimistic UI with
  rollback, terminal-stage confirmation
- Scorecards (1–5 with feedback, one per author per application) and threaded comments
- Ranking weights over exactly six permitted features, with server-side sum validation
- Analytics funnel: reached/currently-here counts, conversion, median time-in-stage,
  time-to-hire, source-of-hire
- Append-only audit log with an admin-only read/export API
- Interview scheduling links with single-purpose expiring tokens
- Calendar OAuth connections with encrypted refresh tokens (code complete)
- RFC 7807 error contract, Swagger docs, 43 spec files / 814 tests

**Eleven recruiter screens** — RC-01, RC-02, RC-03, RC-04, RC-05, RC-06, RC-08, RC-09,
RC-10, RC-12, RC-13 — plus the login screen.

### Partially implemented

| Area                 | State                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| AI pipeline          | All plumbing exists; **no trained model**. Worker off by default                                            |
| Resume upload        | Files can be uploaded and stored; **never parsed**                                                          |
| Calendar integration | Code complete and tested, but **unconfigured locally** — no OAuth credentials, so it cannot be demonstrated |
| Interview scheduling | API works; **no recruiter-facing screen** (that is RC-11)                                                   |
| Frontend testing     | **None** — placeholder script only                                                                          |

### RC-07, RC-11, RC-14 — the exact blockers

| Screen                   | Blocker                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RC-07 Score Override** | No `match_scores` rows exist in the demo tenant, and the schema has **no `override_score` column**. The endpoint exists; there is nothing to override                              |
| **RC-11 Interviews**     | No recruiter-readable interviewer directory — `GET /v1/admin/users` is admin-only, so a recruiter cannot populate an interviewer picker. Scheduling and availability APIs are done |
| **RC-14 Parse Review**   | No parser runs, so `parsed_profiles` is empty; and `GET /v1/jobs/:id/parse-review` is per-job only, with no cross-job aggregate a queue would need                                 |

Both RC-11 and RC-14 appear in the sidebar as disabled entries marked "Later" — visible,
honest, and not pretending to work.

### AI limitations — state these plainly

- **No model is trained.** The service is `reference-stub@not-trained-v0`
- **No resume parsing happens.** `parsed_profiles` is empty; `parseStatus` stays `PENDING`
- **No `match_scores` exist** in the demo tenant
- `aiScoringEnabled` is **false** on every job
- The fairness gate cannot be evaluated because the required datasets do not exist

### Do NOT claim in the viva

❌ "The AI scores candidates" — it does not
❌ "It parses resumes and extracts skills" — it does not
❌ "The model was trained on real data" / any accuracy figure — no model, no metrics
❌ "It ranks candidates automatically" — weights are configured; nothing ranks
❌ "It's production-ready" — say production-_shaped_, then name the gaps
❌ "It handles thousands of users" — never load-tested; talk about design instead
❌ "It has full test coverage" — the API does; the frontend has none
❌ "Calendar integration works" — the code is complete but unconfigured, so undemonstrable
❌ Any claim that RC-07, RC-11 or RC-14 exist

✅ **Do say:** "The AI integration is complete and the seam is real; the model is a
labelled stub because the training data cannot lawfully be obtained for a student
project. Every screen refuses to show a number it cannot source."

---

## 9. 5-minute presentation script

> Speak it plainly. Roughly 700 words ≈ 5 minutes.

Good morning. My project is **TalentLens**, an AI-powered recruitment and applicant
tracking system.

Let me start with the problem. When a company posts one job, it can receive hundreds of
applications. A recruiter then has to read every resume, remember which candidate is at
which stage, and coordinate interviews — usually across spreadsheets and email. Two things
go wrong. First, screening becomes inconsistent, because how carefully a resume gets read
depends on when in the day it was opened, and afterwards there's no record of why anyone
moved forward. Second, when companies automate this, they usually add a keyword filter or
an opaque match score — and a score with no explanation can't be challenged. A system that
automatically rejects people has made a hiring decision nobody can account for.

So I treated this as a governance problem, not only a speed problem. My guiding rule was:
**the system ranks and explains, but a human decides.**

TalentLens is a multi-tenant applicant tracking system with a working recruiter console. A
recruiter can create and publish job requisitions, receive applications, see every
candidate for a job, open a full application record, move candidates through a six-stage
pipeline individually or in bulk, write structured scorecards and comments, configure the
ranking weights, and read an analytics funnel showing conversion, drop-off and time to
hire. There are four user roles — Administrator, Recruiter, Hiring Manager and Candidate —
and each sees only what their role permits.

Technically, it's a monorepo. The frontend is React 18 with Vite and TypeScript, using
TanStack Query for server state — there's no Redux, because almost all the state is server
state. The backend is NestJS with Prisma over PostgreSQL 15, with Redis for a background
job queue and S3 for resume files. There's a separate Python FastAPI service for AI. Every
API error follows the RFC 7807 problem-details standard, so the frontend has one error
path instead of many.

Security was the part I spent most time on. Passwords are hashed with Argon2id. The access
token lives fifteen minutes and is kept **in memory only** — never in localStorage — so a
cross-site scripting attack can't read it. The refresh token is an httpOnly, SameSite
strict cookie that rotates on every use and can only be used once; if a used token is
presented again, the system treats it as stolen and revokes every live session for that
user. On the client I had to add a single-flight lock, because when a page reloads several
requests fail at once, and parallel refreshes on a single-use token would silently log the
user out. I proved that behaviour against the running API before fixing it.

For multi-tenancy, every query is scoped by company, and a record belonging to another
tenant returns **404, not 403** — because a 403 confirms the record exists, which is itself
a leak.

Now the honest part, and I want to be direct about it. The AI integration is built end to
end — the queue, the worker, the database tables, the ranking weights, and a typed
interface where a model plugs in. But **no model is trained**, and the service reports that
about itself: it identifies as "reference stub, not trained, not validated". Training would
need consent-gated historical applications, real hiring outcome labels, a licensed resume
corpus and a fairness dataset — none of which I can lawfully obtain for a student project.
So resumes are stored but not parsed, and no candidate is scored.

I made that limitation a design principle rather than hiding it. Because scoring is off,
the candidate list **removes the score column entirely** instead of greying it out, so an
unscored list can never be mistaken for a scored one that failed to load. On the dashboard,
a metric I have no endpoint for shows a dash and a one-line explanation, instead of a zero
that would look like real information. Fairness is enforced structurally: ranking can only
ever use six named features, so a protected attribute can't become a model input even by
accident.

Eleven of the fourteen specified recruiter screens are implemented. The other three are
blocked on backend capability — there are no scores to override, no recruiter-visible
interviewer list, and no parser output to review — and they appear in the interface marked
"Later" rather than pretending to work.

The API has 814 tests across 43 files, mostly integration tests against a real database.
The frontend has no test suite, which is the clearest gap in the project.

I'd now like to show you the working system.

---

## 10. 10-minute live demo script

**Before you start:** `docker compose up -d postgres redis`, then `pnpm dev`. Open
`http://localhost:5173` — that is the public landing page; the console is behind
**Get started** / **Sign in** in the navbar. If anything is slow, say "it's fetching from
the API" — don't fill silence by clicking randomly.

---

**[0:00–0:45] Login — SC-01**

_Do:_ Start on the landing page, then click **Get started** in the navbar to reach the
login screen. Type `recruiter@talentlens.local` / `DevPassword123!`. Sign in.

> "This is the recruiter login. Passwords are hashed with Argon2id. When I sign in, the
> server returns a fifteen-minute access token that the browser keeps **in memory only** —
> never in localStorage — plus a seven-day refresh cookie that JavaScript cannot read at
> all. I land on the dashboard automatically."

---

**[0:45–2:00] Dashboard — RC-01**

_Do:_ Let it load. Point at each tile, then the funnel snapshot.

> "Open requisitions, total applications, and hires. Below that, a snapshot of the funnel."

_Point at "Awaiting review —":_

> "I want to draw attention to this dash. There is no API that gives a cross-job review
> count, so instead of printing a zero — which would look like real information — the
> screen states that the number doesn't exist yet. That principle runs through the whole
> interface: never claim more than the data supports."

---

**[2:00–3:00] Jobs — RC-02**

_Do:_ Click **Jobs**. Show the Status dropdown and the Department filter.

> "All requisitions for this company. I can filter by status or department. This list uses
> cursor pagination rather than page numbers, which is why it says how many are loaded and
> never shows a total — a cursor-paginated API doesn't count the full set, so claiming a
> total would be inventing one."

---

**[3:00–4:00] Job detail — RC-04**

_Do:_ Click **Full-Stack Engineer**.

> "The requisition: department, location, employment type, required skills and the
> description. The actions offered are only the ones the API will actually accept — a
> published job can be closed but not re-published, and a closed job is read-only, so no
> button appears that would guarantee an error."

---

**[4:00–5:15] Candidates — RC-05**

_Do:_ Click the **Candidates** tab.

> "Eight candidates on this job, newest first. Note the heading says 'eight loaded', not
> 'eight of eight'."

_Point at the blue notice, then at the absent column:_

> "This tells me AI scoring is disabled for this job — and notice there is **no score
> column at all**. The requirement is that it's removed entirely rather than greyed out,
> so an unscored list can never be mistaken for a scored list whose values failed to load.
> That's the honest presentation of a feature that isn't running."

---

**[5:15–6:30] Candidate detail & scorecards — RC-06, RC-13**

_Do:_ Click **Mei Lin Chen**. Scroll to the comment thread, then the scorecards.

> "Her full application record — current stage Interview — with a comment thread the
> hiring team shares."

_At the scorecards:_

> "Two structured scorecards: one from the recruiter, one from the hiring manager, each a
> one-to-five rating with written feedback. The database enforces one scorecard per person
> per candidate with a unique constraint, so a double-submit can't slip two rows through."

_Optionally open the form:_

> "The rating is a radio group, keyboard operable, with a visible focus ring."

---

**[6:30–7:45] Pipeline & bulk actions — RC-09, RC-10**

_Do:_ Back to the job → **Pipeline** tab.

> "The six-stage board. Hired and Rejected are marked Final — they're terminal, and moving
> someone there needs explicit human confirmation, because the system is not permitted to
> end anyone's application on its own."

_Click "Move to…" on a card:_

> "Stage moves use a menu, not drag-and-drop. That's deliberate: drag-only interaction
> isn't keyboard accessible, and accessibility is a stated requirement. The move is
> optimistic — the card jumps immediately and rolls back if the server rejects it."

_Tick two checkboxes:_

> "I can also select several candidates and move them together — bulk operations are capped
> at a hundred server-side."

---

**[7:45–8:45] Ranking weights — RC-08**

_Do:_ Click the **Ranking weights** tab. Drag a slider to break the total.

> "These are the weights a scoring model would use — and there are exactly six, because the
> permitted feature set is closed. No protected attribute like age, gender or nationality
> can ever become a model input; that's enforced by an allow-list in code, not by policy.
> The total must equal one, validated on the server, so the screen blocks saving until it
> balances rather than letting me discover that from an error."

_Reset it._

> "And when I save, the response says no candidate was re-ranked — because no model runs.
> The screen reports that instead of claiming success."

---

**[8:45–9:45] Analytics — RC-12**

_Do:_ Click **Analytics** in the sidebar.

> "The conversion funnel: how many applications ever reached each stage, how many are there
> now, conversion from the previous stage and from the start, and the median time spent in
> each stage. Below it, time to hire — one hire, median twenty-four days — and source of
> hire."

_Point at the source line:_

> "Notice it says eight of nine recorded a source, one did not. An application with no
> recorded channel is reported as 'not recorded' and never folded into 'other', because
> that would turn a data-coverage gap into a finding about a channel."

_Point at any "—":_

> "Every dash is a genuine null. The rule is that a null renders as a dash, never as zero
> percent."

---

**[9:45–10:00] Close**

> "Eleven of the fourteen specified recruiter screens are implemented. The remaining three
> are blocked on backend capability — no scores to override, no recruiter-visible
> interviewer list, and no parser output to review — and they're shown in the sidebar
> marked 'Later' rather than pretending to work. The API has 814 tests across 43 files.
> Thank you — I'm happy to take questions."

---

### If something breaks mid-demo

| Problem                              | Say this, then do this                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| A screen shows an error panel        | "That's the RFC 7807 error contract rendering the server's own message — every failure has a correlation ID for tracing." Then reload |
| Nothing loads at all                 | Check the API is running on 3000. "The frontend proxies to the API; the API isn't up."                                                |
| Login fails                          | Check `docker compose ps` — Postgres must be healthy                                                                                  |
| The board looks empty                | You may be on the DRAFT "Senior Backend Engineer" job, which has no applicants. Switch to **Full-Stack Engineer**                     |
| You're asked for something not built | "That isn't implemented, and here's the specific backend reason why." Never improvise a feature                                       |
