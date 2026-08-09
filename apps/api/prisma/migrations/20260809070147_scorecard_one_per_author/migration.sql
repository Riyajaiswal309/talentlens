-- APPROVED (9 Aug 2026): exactly one scorecard per author per application.
--
-- Phase 1 HM-04 lists "already-submitted" as an error state. Enforced by the
-- database, not by a service-level lookup: a read-then-write check loses to a
-- concurrent double-submit, and the duplicate it lets through would be
-- invisible until someone noticed two ratings from one interviewer.
--
-- Verified empty of violating pairs before creation.

-- CreateIndex
CREATE UNIQUE INDEX "scorecards_application_id_author_id_key" ON "scorecards"("application_id", "author_id");

