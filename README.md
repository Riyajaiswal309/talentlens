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

---

## Prerequisites

| Tool    | Required                       | Why                           |
| ------- | ------------------------------ | ----------------------------- |
| Node.js | **20+** (PRD §16 specifies 20) | Core API and web build        |
| pnpm    | 9.15.0                         | Workspace manager (PRD §16.1) |
| Docker  | Any recent                     | Postgres 15 + Redis 7 locally |
| Python  | **3.11** (PRD §16)             | AI service — Phase 3 only     |

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
│   └── ai-service/    FastAPI scaffold — Phase 3, not implemented
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

| Phase  | Scope                                                         | Status               |
| ------ | ------------------------------------------------------------- | -------------------- |
| P1     | Requirements & UX design                                      | ✅ Complete          |
| **P2** | **Core platform — jobs, applications, pipeline, RBAC, audit** | **🔨 M2.1 of M2.10** |
| P3     | AI screening — parsing, ranking, explainability               | ⏳ Not started       |
| P4     | QA, accessibility, fairness testing                           | ⏳                   |
| P5     | Beta                                                          | ⏳                   |
| P6     | General availability                                          | ⏳                   |

### Rules this codebase enforces

From PRD §13. They are constraints on implementation, not features:

- **BR-01** No candidate is rejected by AI. Terminal stage changes require a human actor.
- **BR-02** No score without a rationale — enforced at the database level.
- **BR-03** Every override is audited with a reason, written before the response returns.
- **BR-04** Only Administrators toggle AI scoring per job.
- **BR-05** Candidate data is purpose-limited and erasable.
- **BR-06** Role-restricted PII; foreign records return 404, never 403.
- **BR-07** No protected attribute is ever a model input.
