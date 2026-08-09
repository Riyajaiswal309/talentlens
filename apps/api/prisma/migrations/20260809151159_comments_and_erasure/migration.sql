-- Remaining-gaps pass: FR5.3 comments and BR-05 erasure attribution.
--
-- comments            FR5.3 reads "Comments AND scorecards are visible to the
--                     full hiring team". PRD §17 models scorecards only, so the
--                     requirement was half implementable and the Handoff's
--                     "FR5.3 ✅ Full" was inaccurate. Shaped after `scorecards`,
--                     its documented sibling.
--
-- candidates.erased_by
--                     BR-05 / PRD §18: "erasing a candidate detaches PII while
--                     leaving the audit skeleton intact". `deleted_at` already
--                     existed; this records WHO ran it, so an erasure is
--                     attributable rather than anonymous.
--
-- Both additive. `comments` starts empty and `erased_by` is nullable, so no
-- backfill is needed.

-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "erased_by" UUID;

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comments_application_id_created_at_idx" ON "comments"("application_id", "created_at");

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Grants for the restricted application role.
--
-- REQUIRED, and easy to forget. The M2.2 migration grants table by table and
-- sets no ALTER DEFAULT PRIVILEGES — deliberately, because `audit_logs` gets
-- only INSERT and SELECT and a blanket default would have handed it UPDATE
-- and DELETE, destroying the append-only guarantee PRD §17.3 depends on.
--
-- The cost of that choice is that EVERY new table needs its own GRANT. Without
-- this block the API, which connects as `talentlens_app`, cannot see `comments`
-- at all and every request 500s.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "comments" TO "talentlens_app";
