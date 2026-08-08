-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'RECRUITER', 'HIRING_MANAGER', 'CANDIDATE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ParseStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "data_region" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "password_hash" TEXT,
    "last_active_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT,
    "location" TEXT,
    "employment_type" TEXT,
    "experience_level" TEXT,
    "description" TEXT,
    "required_skills" JSONB NOT NULL DEFAULT '[]',
    "ai_scoring_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_assignments" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "is_terminal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "current_stage" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resumes" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "s3_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "parse_status" "ParseStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parsed_profiles" (
    "id" UUID NOT NULL,
    "resume_id" UUID NOT NULL,
    "skills" JSONB NOT NULL DEFAULT '[]',
    "work_history" JSONB NOT NULL DEFAULT '[]',
    "education" JSONB NOT NULL DEFAULT '[]',
    "certifications" JSONB NOT NULL DEFAULT '[]',
    "confidence_score" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "parsed_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_versions" (
    "id" UUID NOT NULL,
    "model_name" TEXT NOT NULL,
    "version_tag" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "promoted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_model_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_scores" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "model_version_id" UUID NOT NULL,
    "composite_score" DECIMAL(5,4) NOT NULL,
    "rationale" JSONB NOT NULL,
    "feature_vector" JSONB NOT NULL,
    "overridden_by" UUID,
    "override_reason" TEXT,
    "scored_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "match_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_history" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_stage" TEXT,
    "to_stage" TEXT NOT NULL,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecards" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "feedback" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_company_id_role_idx" ON "users"("company_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "users_company_id_email_key" ON "users"("company_id", "email");

-- CreateIndex
CREATE INDEX "jobs_company_id_status_idx" ON "jobs"("company_id", "status");

-- CreateIndex
CREATE INDEX "jobs_required_skills_idx" ON "jobs" USING GIN ("required_skills");

-- CreateIndex
CREATE INDEX "job_assignments_user_id_idx" ON "job_assignments"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_assignments_job_id_user_id_key" ON "job_assignments"("job_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stages_job_id_position_key" ON "pipeline_stages"("job_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stages_job_id_name_key" ON "pipeline_stages"("job_id", "name");

-- CreateIndex
CREATE INDEX "candidates_email_idx" ON "candidates"("email");

-- CreateIndex
CREATE INDEX "applications_job_id_current_stage_idx" ON "applications"("job_id", "current_stage");

-- CreateIndex
CREATE INDEX "applications_candidate_id_idx" ON "applications"("candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "resumes_application_id_key" ON "resumes"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "parsed_profiles_resume_id_key" ON "parsed_profiles"("resume_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_versions_model_name_version_tag_key" ON "ai_model_versions"("model_name", "version_tag");

-- CreateIndex
CREATE INDEX "match_scores_application_id_scored_at_idx" ON "match_scores"("application_id", "scored_at" DESC);

-- CreateIndex
CREATE INDEX "match_scores_rationale_idx" ON "match_scores" USING GIN ("rationale");

-- CreateIndex
CREATE INDEX "stage_history_application_id_changed_at_idx" ON "stage_history"("application_id", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "scorecards_application_id_idx" ON "scorecards"("application_id");

-- CreateIndex
CREATE INDEX "audit_logs_resource_id_created_at_idx" ON "audit_logs"("resource_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parsed_profiles" ADD CONSTRAINT "parsed_profiles_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "ai_model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_overridden_by_fkey" FOREIGN KEY ("overridden_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Raw SQL additions — constraints Prisma schema language cannot express.
-- Source: Master PRD v3.0 §17.3 and §17.4.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. BR-02 / PRD §17.3 — composite_score must lie in [0,1].
-- ---------------------------------------------------------------------------
ALTER TABLE "match_scores"
  ADD CONSTRAINT "match_scores_composite_score_range"
  CHECK ("composite_score" >= 0 AND "composite_score" <= 1);

-- ---------------------------------------------------------------------------
-- 2. PRD §17.4 — PARTIAL index on the parse review queue. Keeps the index
--    small as the table grows, since completed rows are the vast majority.
-- ---------------------------------------------------------------------------
CREATE INDEX "resumes_parse_status_pending_idx"
  ON "resumes" ("parse_status")
  WHERE "parse_status" <> 'COMPLETED';

-- ---------------------------------------------------------------------------
-- 3. PRD §17.3 — audit_logs is append-only ENFORCED BY GRANT.
--
--    A table OWNER bypasses GRANT/REVOKE in PostgreSQL, so revoking from the
--    owning role would achieve nothing. The restriction therefore requires a
--    separate, non-owner application role. Migrations continue to run as the
--    owner; the application connects as this restricted role.
--
--    The role is created NOLOGIN with no password. Assigning a password is an
--    environment-specific step so that no credential is ever committed
--    (PRD §24.3). See scripts/grant-app-login.sql for local development.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talentlens_app') THEN
    CREATE ROLE "talentlens_app" NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO "talentlens_app";

-- Full DML on operational tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "companies", "users", "jobs", "job_assignments", "pipeline_stages",
  "candidates", "applications", "resumes", "parsed_profiles",
  "ai_model_versions", "match_scores", "scorecards"
  TO "talentlens_app";

-- FR5.4 — stage_history is append-only; transitions are never rewritten.
GRANT SELECT, INSERT ON "stage_history" TO "talentlens_app";
REVOKE UPDATE, DELETE ON "stage_history" FROM "talentlens_app";

-- PRD §17.3 — audit_logs: INSERT and SELECT only. This is the enforcement
-- point for FR8.3 and NFR8. No API path can mutate an audit record because
-- the database will not permit it.
GRANT SELECT, INSERT ON "audit_logs" TO "talentlens_app";
REVOKE UPDATE, DELETE ON "audit_logs" FROM "talentlens_app";
