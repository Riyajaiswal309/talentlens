-- CreateTable
CREATE TABLE "application_tags" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "application_tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "application_tags_application_id_idx" ON "application_tags"("application_id");

-- AddForeignKey
ALTER TABLE "application_tags" ADD CONSTRAINT "application_tags_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_tags" ADD CONSTRAINT "application_tags_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FR5.2 — duplicates are prevented by the DATABASE, not by a service check.
--
-- Functional and case-insensitive, so "Python" and "python" are one tag rather
-- than two. Prisma's schema language cannot express an index over an
-- expression, so it is applied here as raw SQL — the same route the composite
-- score CHECK and the partial resume index already take.
--
-- Enforcing it here rather than in the service is deliberate: a read-then-write
-- duplicate check loses a concurrent double-submit, exactly as recorded on
-- `scorecards`' own unique constraint.
CREATE UNIQUE INDEX "application_tags_application_id_label_lower_key"
  ON "application_tags" ("application_id", lower("label"));
