-- FR6.1 Phase 1 — the calendar connection foundation (amendments D34–D45).
--
-- Storage only. No Google or Microsoft integration, no OAuth, no availability
-- and no event synchronisation are part of this migration or the code that
-- accompanies it.
--
-- calendar_connections  PRD §17.2 defines no connection entity; FR6.1 cannot
--                       work without one. The contract this implements was
--                       approved as D34–D45 rather than derived from the text.
--
-- OWNERSHIP (D34)       The row belongs to the `users` row that authorised it.
--                       No tenant-wide service account, no recruiter acting on
--                       a colleague's behalf. There is deliberately NO
--                       company_id column: tenancy is reached through the
--                       owner's `users.company_id`, the same indirection
--                       `applications` uses through its job, so the two can
--                       never drift apart.
--
-- account_identifier    D37. The provider-side account actually authorised,
--                       captured explicitly. `users.email` is unique per tenant
--                       only and is never assumed to be the calendar identity.
--
-- encrypted_refresh_token
--                       D36 / D45. NULLABLE and NEVER PLAINTEXT — sealed by the
--                       application layer before it reaches the database. §24.3
--                       already encrypts RDS with AES-256/KMS, but that defends
--                       against a stolen disk rather than a read of this table.
--                       Nullable because a disconnected connection holds no
--                       credential: entering that state clears the column
--                       instead of leaving a dead secret at rest.
--
-- NO ACCESS-TOKEN COLUMN. D36 makes access tokens short-lived runtime values;
-- there is nowhere here to persist one, by design.
--
-- UNIQUE (user_id, provider)
--                       Re-authorising a provider REPLACES the stored
--                       credential rather than accumulating rows, so the
--                       adapter is never ambiguous about which token to use.
--                       A user may hold one Google and one Microsoft
--                       connection at once, which D35 requires.
--
-- Additive only. The table starts empty, no backfill is possible or wanted,
-- and no existing table is altered.

-- CreateEnum
CREATE TYPE "CalendarProvider" AS ENUM ('google', 'microsoft');

-- CreateEnum
CREATE TYPE "CalendarConnectionStatus" AS ENUM ('connected', 'disconnected');

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "CalendarProvider" NOT NULL,
    "account_identifier" TEXT NOT NULL,
    "status" "CalendarConnectionStatus" NOT NULL DEFAULT 'connected',
    "encrypted_refresh_token" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "disconnected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_connections_user_id_idx" ON "calendar_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_user_id_provider_key" ON "calendar_connections"("user_id", "provider");

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Grant for the restricted application role.
--
-- REQUIRED for every new table (standing rule A10). M2.2 grants table by table
-- and sets no ALTER DEFAULT PRIVILEGES, deliberately, because a blanket default
-- would have handed `audit_logs` the UPDATE and DELETE that PRD §17.3's
-- append-only guarantee depends on not existing.
--
-- Without this block the API, which connects as `talentlens_app`, cannot see
-- `calendar_connections` at all and every request touching it returns 500.
-- `comments` hit exactly that in the remaining-gaps pass.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_connections" TO "talentlens_app";
