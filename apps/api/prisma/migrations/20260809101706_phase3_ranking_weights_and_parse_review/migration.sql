-- Phase 3 integration — FR4.2 ranking weights and FR3.2 parse review.
--
-- jobs.ranking_weights          Handoff Gap 2. NULL means defaults apply,
--                               which is the `isDefault` flag in the response.
--                               Keys are constrained to the six PRD Table 19.1
--                               features at the API boundary (BR-07).
-- jobs.ranking_weights_updated_at
--                               Gap 2 returns its own updatedAt; jobs.updated_at
--                               moves on any edit and would misreport it.
--
-- parsed_profiles.field_confidence
--                               FR3.2 / §20 stage 5. Per-field confidence keyed
--                               by field path; anything below 0.75 is flagged
--                               for review rather than silently accepted.
-- parsed_profiles.field_confirmations
--                               Gap 3 rule 4. Who confirmed which field, so a
--                               corrected value is attributable.
--
-- All four are additive and nullable or defaulted, so existing rows are valid
-- without a backfill.

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "ranking_weights" JSONB,
ADD COLUMN     "ranking_weights_updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "parsed_profiles" ADD COLUMN     "field_confidence" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "field_confirmations" JSONB NOT NULL DEFAULT '{}';
