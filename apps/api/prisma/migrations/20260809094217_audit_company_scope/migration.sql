-- M2.10 — tenant scope for the audit trail (approved 9 Aug 2026).
--
-- The audit browser must refuse cross-tenant reads, but audit_logs had no
-- tenant column: actor_id resolves it for USER rows and is NULL for every
-- PUBLIC row (FR2.1 application submissions), so ~80% of the table had no
-- tenant link at all.
--
-- Nullable on purpose. Every NEW row is required to carry a tenant --
-- AuditService refuses to write without one -- but rows written before this
-- column existed can only be backfilled where the relationship is
-- deterministic. Anything that cannot be resolved stays NULL and is treated
-- as historical/unscoped; guessing would file real events under the wrong
-- tenant, which is worse than admitting they predate the column.
--
-- RESTRICT matches actor_id: PRD §18 keeps the audit log out of cascade
-- deletes, so a company carrying audit history cannot be removed silently.

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "company_id" UUID;

-- CreateIndex
CREATE INDEX "audit_logs_company_id_created_at_idx" ON "audit_logs"("company_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill, deterministic paths only.
-- ---------------------------------------------------------------------------

-- 1. USER rows: the actor's own tenant.
UPDATE "audit_logs" a
   SET "company_id" = u."company_id"
  FROM "users" u
 WHERE a."actor_id" = u."id"
   AND a."company_id" IS NULL;

-- 2. Rows about a job.
UPDATE "audit_logs" a
   SET "company_id" = j."company_id"
  FROM "jobs" j
 WHERE a."resource_type" = 'job'
   AND a."resource_id" = j."id"
   AND a."company_id" IS NULL;

-- 3. Rows about an application, including PUBLIC submissions -- the tenant is
--    reached through the job the application belongs to.
UPDATE "audit_logs" a
   SET "company_id" = j."company_id"
  FROM "applications" app
  JOIN "jobs" j ON j."id" = app."job_id"
 WHERE a."resource_type" = 'application'
   AND a."resource_id" = app."id"
   AND a."company_id" IS NULL;

-- 4. Rows about a match score.
UPDATE "audit_logs" a
   SET "company_id" = j."company_id"
  FROM "match_scores" ms
  JOIN "applications" app ON app."id" = ms."application_id"
  JOIN "jobs" j ON j."id" = app."job_id"
 WHERE a."resource_type" = 'match_score'
   AND a."resource_id" = ms."id"
   AND a."company_id" IS NULL;

-- Anything still NULL refers to a resource that no longer exists. Left alone.
