-- Phase 2b — FR6 interview scheduling (Handoff decision D3 defers FR6 to here).
--
-- interviews             PRD §17.2 Table 17.1 names this table with `id`,
--                        `application_id`, `scheduled_at` and
--                        `calendar_event_id`; Phase 1 line 1240 adds `status`.
--                        `timezone`, `selected_slot_id` and `created_by` come
--                        from Handoff Gap 7's request/response shapes and
--                        RC-11's attribution of the booking.
--
-- interview_slots        Gap 7 validation rule 2 — a confirmed `slotId` must
--                        "belong to the set offered by *this* token". The set
--                        has to be stored to be checked.
--
-- interview_interviewers Gap 7 returns `interviewerNames: []` and RC-11 has an
--                        interviewer picker. A join table rather than a name
--                        array, so the panel cannot drift from `users`.
--
-- `scheduled_at` and `calendar_event_id` are both nullable, and that is the
-- normal case rather than an error state: FR6.2 creates the interview before
-- the candidate has picked a time, and FR6.3 requires the workflow to complete
-- with no calendar provider at all.
--
-- Additive only. All three tables start empty, so no backfill is needed and
-- nothing existing is rewritten.

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('PENDING_SELECTION', 'SCHEDULED', 'CANCELLED');

-- CreateTable
CREATE TABLE "interviews" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "status" "InterviewStatus" NOT NULL DEFAULT 'PENDING_SELECTION',
    "scheduled_at" TIMESTAMPTZ(6),
    "timezone" TEXT,
    "calendar_event_id" TEXT,
    "selected_slot_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_slots" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interview_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_interviewers" (
    "interview_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_interviewers_pkey" PRIMARY KEY ("interview_id","user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "interviews_selected_slot_id_key" ON "interviews"("selected_slot_id");

-- CreateIndex
CREATE INDEX "interviews_application_id_created_at_idx" ON "interviews"("application_id", "created_at");

-- CreateIndex
CREATE INDEX "interview_slots_interview_id_starts_at_idx" ON "interview_slots"("interview_id", "starts_at");

-- CreateIndex
CREATE INDEX "interview_interviewers_user_id_idx" ON "interview_interviewers"("user_id");

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_selected_slot_id_fkey" FOREIGN KEY ("selected_slot_id") REFERENCES "interview_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_slots" ADD CONSTRAINT "interview_slots_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_interviewers" ADD CONSTRAINT "interview_interviewers_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_interviewers" ADD CONSTRAINT "interview_interviewers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Grants for the restricted application role.
--
-- REQUIRED for every new table, and easy to forget. M2.2 grants table by table
-- and deliberately sets no ALTER DEFAULT PRIVILEGES, because a blanket default
-- would have handed `audit_logs` the UPDATE and DELETE that PRD §17.3's
-- append-only guarantee depends on not existing.
--
-- The standing cost of that choice: a table created without its own GRANT is
-- invisible to `talentlens_app` and every request touching it returns 500.
-- `comments` hit exactly that in the remaining-gaps pass. Three tables here,
-- three grants.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "interviews" TO "talentlens_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "interview_slots" TO "talentlens_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "interview_interviewers" TO "talentlens_app";
