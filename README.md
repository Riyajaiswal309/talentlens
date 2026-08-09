# TalentLens

AI-Powered Recruitment & Applicant Tracking System.
B.Tech CSE final-year project · Riya Jaiswal · GD Goenka University · 2026–27

**Current milestone: M2.1 — workspace scaffold.**
No business features, no database schema, no AI. See `docs/` for the governing documents.

---

## Governing documents

Everything in this repository traces to these three. They are the source of truth,
not the code.

| Document                            | Role                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| `docs/master-prd-v3.pdf`            | Master PRD v3.0 — requirements, architecture, business rules |
| `docs/phase1-requirements-ux.pdf`   | Phase 1 — traceability, screens, flows, design system        |
| `docs/phase1-to-phase2-handoff.pdf` | Handoff v1.1 — API contracts, entities, Definition of Done   |
| `docs/PRD-AMENDMENTS.md`            | What the build does that the PRD/Handoff do not yet say      |

---

## Prerequisites

| Tool    | Required                       | Why                           |
| ------- | ------------------------------ | ----------------------------- |
| Node.js | **20+** (PRD §16 specifies 20) | Core API and web build        |
| pnpm    | 9.15.0                         | Workspace manager (PRD §16.1) |
| Docker  | Any recent                     | Postgres 15 + Redis 7 locally |
| Python  | **3.11** (PRD §16)             | AI service — reference stub   |

Install pnpm without touching system directories:

```bash
mkdir -p ~/.local/bin
corepack enable --install-directory ~/.local/bin pnpm
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc to persist
```

---

## Setup

```bash
# 1. Environment
cp .env.example .env

# 2. Dependencies
pnpm install

# 3. Infrastructure (Postgres 15 + Redis 7)
docker compose up -d

# 4. Run both apps
pnpm dev
```

| Service    | URL                          |
| ---------- | ---------------------------- |
| Web        | http://localhost:5173        |
| API        | http://localhost:3000        |
| API health | http://localhost:3000/health |
| Postgres   | localhost:5432               |
| Redis      | localhost:6379               |

---

## Workspace layout

```
talentlens/
├── apps/
│   ├── web/           React 18 + Vite + TypeScript + Tailwind
│   ├── api/           NestJS core API
│   └── ai-service/    FastAPI — Phase 3 integration; reference stub, NOT a model
├── packages/
│   └── shared-types/  Types shared between web and api
├── docs/              PRD and phase documents
└── docker-compose.yml Postgres 15 + Redis 7
```

---

## Commands

| Command                        | Effect                          |
| ------------------------------ | ------------------------------- |
| `pnpm dev`                     | Run web and api together        |
| `pnpm build`                   | Build all packages and apps     |
| `pnpm lint`                    | ESLint across the workspace     |
| `pnpm format`                  | Prettier write                  |
| `pnpm typecheck`               | TypeScript across all packages  |
| `pnpm test`                    | Test suites                     |
| `pnpm infra:up` / `infra:down` | Start / stop Postgres and Redis |

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

### On P3: what "integration only" means

The parse-and-score pipeline is built and tested end to end — queue, worker,
`parsed_profiles`, atomic `match_scores`, ranking weights, parse review. **No
model is trained.** PRD §19.2 requires consent-gated historical application
data, recruiter accept/reject/hire labels, a licensed resume corpus, a
human-verified golden NER dataset and an access-restricted fairness dataset;
none exists here, so §19.6's promotion gates cannot be evaluated and its
fairness gate has no override path.

`apps/ai-service` therefore serves a deterministic reference stub,
`reference-stub@not-trained-v0` — not a trained model, not validated, not
promotable, and not evidence of parsing, ranking or fairness performance.
P4's fairness testing is blocked on that, not on this repository.

### Rules this codebase enforces

From PRD §13. They are constraints on implementation, not features:

- **BR-01** No candidate is rejected by AI. Terminal stage changes require a human actor.
- **BR-02** No score without a rationale — enforced at the database level.
- **BR-03** Every override is audited with a reason, written before the response returns.
- **BR-04** Only Administrators toggle AI scoring per job.
- **BR-05** Candidate data is purpose-limited and erasable.
- **BR-06** Role-restricted PII; foreign records return 404, never 403.
- **BR-07** No protected attribute is ever a model input.
