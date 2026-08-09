# PRD / Handoff amendments outstanding

Everything the implementation does that the Master PRD v3.0 or the Phase 1 →
Phase 2 Handoff v1.1 does not yet say. Each entry was derived from the
repository at the commit that introduced it, not from recollection, and names
the approval that authorised it.

Nothing here is a defect. These are decisions that were taken, tested and
committed, and that the documents have not caught up with.

**Verification:** the endpoint list came from the route decorators, the schema
list from `information_schema`, and the audit list from a source-tree scan of
emitted action strings. A test (`audit.spec.ts`, "every action production code
emits is filterable") now fails if the audit vocabulary drifts from the code
again.

---

## A. Database — PRD §17

PRD §17.2 defines 13 tables; the build has 14, plus seven column or constraint
additions.

| #   | Change                                                                                                                                                                                                                                                                    | Authorised by                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A1  | **`job_assignments` table** — §24.2 grants Hiring Managers "assigned jobs only" but §17 defines no table storing the assignment, leaving the permission unimplementable.                                                                                                  | Decision B1, 8 Aug 2026               |
| A2  | **`candidates.user_id`** — nullable, unique FK to `users`. A candidate profile may exist without a login, and a login may exist before a profile.                                                                                                                         | Candidate-identity ruling, 8 Aug 2026 |
| A3  | **`audit_logs.actor_type`** (`USER` \| `PUBLIC`) with the `audit_logs_actor_pairing` CHECK. §17.3 declared `actor_id NOT NULL`, but FR2.1's `application.submitted` is written by an unauthenticated caller, so a required record was unwritable.                         | Audit-actor ruling, 8 Aug 2026        |
| A4  | **`audit_logs.company_id`** — nullable, `ON DELETE RESTRICT`, indexed. The audit browser must refuse cross-tenant reads and `audit_logs` had no tenant column. Nullable because rows predating the column cannot all be resolved; every new row is required to carry one. | M2.10 ruling, 9 Aug 2026              |
| A5  | **`scorecards` UNIQUE `(application_id, author_id)`** — one scorecard per author per application, enforced in the database so a concurrent double-submit cannot pass a read-then-write.                                                                                   | M2.8 ruling, 9 Aug 2026               |
| A6  | **`jobs.ranking_weights`** + **`ranking_weights_updated_at`** — FR4.2 / Handoff Gap 2 needs per-job weights and its own timestamp; `jobs.updated_at` moves on any edit.                                                                                                   | Phase 3, Gap 2                        |
| A7  | **`parsed_profiles.field_confidence`** + **`field_confirmations`** — FR3.2 / §20 stage 5 flags fields below 0.75; Gap 3 rule 4 records who confirmed each one.                                                                                                            | Phase 3, Gap 3                        |

## B. Endpoints — PRD §23.2

Handoff decision **D4** already authorises amending §23.2 with the unlisted
endpoints and naming ten. The built total is **eighteen**.

Named in D4 and built:

`GET /v1/auth/me` · `GET /v1/jobs/:id` · `GET /v1/public/jobs` ·
`GET /v1/public/jobs/:id` · `GET /v1/me/reviews` · `GET /v1/audit-logs` ·
`GET /v1/audit-logs/:id` · `GET /v1/admin/users` · `POST /v1/admin/users` ·
`PATCH /v1/admin/users/:id/role` · `DELETE /v1/admin/users/:id/sessions` ·
`PATCH /v1/applications/bulk/stage` · `GET /v1/jobs/:id/ranking-weights` ·
`PUT /v1/jobs/:id/ranking-weights` · `GET /v1/jobs/:id/parse-review`

Not named in D4 and requiring their own line:

| #   | Endpoint                                               | Why it exists                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `GET /v1/applications/:id/scorecards`                  | FR5.3 team visibility. Phase 1 states the criterion as "scorecards listed on candidate detail", but Handoff row 13 excludes Hiring Managers from `GET /v1/applications/:id`, so serving them there would withhold it from the role HM-03 shows it to. |
| B2  | `PATCH /v1/parsed-profiles/:id`                        | Handoff Table B.2 lists it as deferred to Phase 3; built in the Phase 3 integration.                                                                                                                                                                  |
| B3  | `ALL /v1/audit-logs`, `ALL /v1/audit-logs/*` → **405** | Gap 4 rule 3 requires write verbs to return 405. Two handlers, because a stacked pair of `@All` decorators registers only one.                                                                                                                        |

## C. Audit vocabulary — Handoff §I

| #   | Action                        | Emitted by                                      |
| --- | ----------------------------- | ----------------------------------------------- |
| C1  | `job.ranking_weights_changed` | `PUT /v1/jobs/:id/ranking-weights` (FR4.2)      |
| C2  | `parsed_profile.corrected`    | `PATCH /v1/parsed-profiles/:id` (FR2.2 / FR3.2) |

Both were added to the browser's filterable vocabulary during the Phase 3
closeout; before that an administrator filtering for a real event received a 400.

## D. Behavioural rulings to record

| #   | Ruling                                                                                                                                                                                                                                                                                                  | Source     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D1  | **Candidate deduplication** — every public submission creates its own `candidates` row. The table is not tenant-scoped and the endpoint is unauthenticated, so matching on email would join strangers' records across companies.                                                                        | 8 Aug 2026 |
| D2  | **LocalStack (A1) and the ClamAV boundary (B1)** — S3 via LocalStack locally; the AV scan ships as a `ResumeScanner` seam with a pass-through implementation, bound in one place.                                                                                                                       | 8 Aug 2026 |
| D3  | **Resume upload is mandatory**, max 10 MB, PDF/DOCX, magic-byte checked. FR2.1 is "apply via resume upload" and CA-02 offers no skip.                                                                                                                                                                   | 8 Aug 2026 |
| D4  | **`Idempotency-Key` semantics** — optional; a repeat replays the original response; the same key with a different request is refused with 409 rather than silently answering the wrong submission. §23.1 specifies neither.                                                                             | 9 Aug 2026 |
| D5  | **Closed jobs stay open to pipeline movement.** The specification makes a closed _job_ read-only (RC-04); it does not freeze its applications.                                                                                                                                                          | 9 Aug 2026 |
| D6  | **Scorecard rating is an integer 1–5.** Phase 1 HM-04 says "rating scale" without bounds.                                                                                                                                                                                                               | 9 Aug 2026 |
| D7  | **`/v1/me/reviews` scopes Administrators through `job_assignments`**, exactly like Hiring Managers. Gap 1 states the rule without exempting them, and an empty queue is explicitly "not an error".                                                                                                      | 9 Aug 2026 |
| D8  | **Invited users carry no status column.** `users.password_hash` is already nullable and AuthService cannot authenticate without one, so an invited record exists and cannot log in.                                                                                                                     | 9 Aug 2026 |
| D9  | **`PATCH /v1/applications/:id/score` returns 404 while no score exists**, which is every application until a model runs. A score is never fabricated: that would need a rationale and feature vector, which BR-02 and BR-07 exist to prevent.                                                           | 9 Aug 2026 |
| D10 | **Audit query span capped at 366 days** (Handoff decision D8) and **`jobId` takes the wider meaning** — the job, its applications, and the scorecards and match scores on those applications.                                                                                                           | 9 Aug 2026 |
| D11 | **§24.2 withholds AI scores from candidates.** Table 24.1 reads "View AI rankings + rationale: Candidate —", so `GET /v1/applications/:id` does not fetch a score for a candidate caller. §24.5's candidate-facing explanation is a separate request process.                                           | Phase 3    |
| D12 | **The AI seam is `PersistedAiProvider`, not an HTTP provider.** `getScore` reads `match_scores`; `requestParse` publishes to the queue. The HTTP boundary lives in the worker, where §23.1 puts it — calling a model from a request path would make a page load wait on inference, which §15.1 forbids. | Phase 3    |

## E. Corrections to already-written text

| #   | Correction                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | **Handoff FR-coverage table marks FR5.3 "✅ Full".** Only the scorecards half is delivered; **comments have no table** and are not built. The row should read Partial.                                                                                                                                          |
| E2  | **BR-07 feature identifiers.** M2.9 guessed `education_level_match` and `certification_match_count` and marked them provisional. Handoff Gap 2 prints all six verbatim: the correct names are `education_match` and `certification_match`. Corrected in code; the wrong names are pinned as rejected by a test. |

## F. Not amendments — open items carried forward

Deferred by explicit ruling, or blocked, and recorded here so they are not
mistaken for oversights:

- **TOTP MFA for Administrators** (§24.1) — never built; Admin login is
  password-only.
- **Password reset** (Handoff D6) — absent from the PRD; not built silently.
- **`NotificationsModule`** (FR2.3) — appears in the Handoff module table but
  **no milestone owns it**. Email delivery is not built, including for invites.
- **Comments storage** (FR5.3) — see E1.
- **Scorecard structured prompts and save-draft** (HM-04) — deferred; neither
  is PRD-named.
- **Terminal-stage filtering in `/v1/me/reviews`** — no rule specified; current
  behaviour includes them.
- **Malformed-cursor handling** in `list-jobs`, `list-public-jobs` and
  `list-job-candidates` — `cursor` is typed as a bare string, so a malformed
  value likely 500s. `/v1/me/reviews` and the audit browser validate it as a
  UUID and return 400.
- **BR-05 erasure routine** — `deleted_at` exists and is honoured on read; no
  erasure process is implemented.
- **FR6 (interviews) and FR7 (analytics)** — Handoff decision D3 recommends
  deferral to Phase 2b; the deferral has never been formally recorded.
- **The real AI work** — see below.

## G. Blocked: the model half of Phase 3

Not amendments, and not schedulable. PRD §19.2 requires consent-gated
historical application data, recruiter accept/reject/hire labels, a licensed
resume corpus, a human-verified golden NER dataset, and an access-restricted
fairness dataset carrying protected-attribute labels. **None exists for this
project.**

Without them nothing can be trained, and §19.6's gates cannot be evaluated at
all: parsing field-level F1 ≥0.90 _on the golden dataset_, the four-fifths
adverse-impact ratio _across all protected groups_, and NDCG@10 _against a
current production model_. §19.6 states the fairness gate has **no override
path**, so no model could be promoted even if one were trained.

Consequently absent: spaCy NER · pdfplumber / python-docx extraction ·
Tesseract OCR fallback (FR3.4) · sentence-transformers embeddings · LightGBM
re-ranker · SHAP attribution (§22) · MLflow registry · the §21.4 fairness
audit.

`apps/ai-service` serves `reference-stub@not-trained-v0`, a deterministic
stand-in labelled in the module docstring, the service README, the FastAPI
description, the `/health` payload and the version tag itself as not trained,
not validated, not promotable and not evidence of any performance. It is
recorded in `ai_model_versions` with `status = 'reference'`, never
`'promoted'`.

**P4 (QA, accessibility and fairness testing) is blocked on this**, not on the
core platform.
