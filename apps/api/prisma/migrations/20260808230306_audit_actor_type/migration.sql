-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'PUBLIC');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actor_type" "AuditActorType" NOT NULL DEFAULT 'USER',
ALTER COLUMN "actor_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_created_at_idx" ON "audit_logs"("actor_type", "created_at" DESC);


-- APPROVED RESOLUTION of the audit-actor PRD GAP (8 Aug 2026).
-- Enforce the actor pairing in the DATABASE so an audit row can never claim
-- an actor it does not have, nor hide one it does:
--   USER   -> actor_id IS NOT NULL
--   PUBLIC -> actor_id IS NULL
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_actor_pairing"
  CHECK (
    ("actor_type" = 'USER'   AND "actor_id" IS NOT NULL) OR
    ("actor_type" = 'PUBLIC' AND "actor_id" IS NULL)
  );
