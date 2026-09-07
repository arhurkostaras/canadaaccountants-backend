-- Migration 005: profile disputes (public "correct or remove this profile" flow)
--
-- A person named on a public profile submits a dispute from
-- GET/POST /api/profiles/:id/dispute. The row is hidden the moment the
-- request lands (dispute_pending = true); an admin later resolves it as
-- removed (removed_at set, hidden for good), corrected, or restored (visible
-- again). Both flags live on the professional table so the existing 410 gate
-- in server.js and every public listing query read them with no join.
--
-- Column defaults are constants, so ADD COLUMN is a catalog-only change on
-- PostgreSQL 11+ (no table rewrite on the 2.5M-row scraped_cpas).
--
-- Idempotent: applied on every boot by services/profile-disputes.js
-- ensureSchema() and safe to run again via psql.

ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS dispute_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_scraped_cpas_hidden
  ON scraped_cpas (id) WHERE dispute_pending OR removed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS profile_disputes (
  id              SERIAL PRIMARY KEY,
  profile_id      INTEGER      NOT NULL,           -- scraped_cpas.id (no FK: the row may later be hard-deleted)
  reason          VARCHAR(40)  NOT NULL,
  details         TEXT,
  requester_email VARCHAR(255) NOT NULL,           -- may differ from the profile's own address
  requester_ip    VARCHAR(64),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  resolution      VARCHAR(20),
  resolved_by     VARCHAR(255),
  CONSTRAINT profile_disputes_reason_chk
    CHECK (reason IN ('remove', 'correct', 'not_private_practice', 'other')),
  CONSTRAINT profile_disputes_resolution_chk
    CHECK (resolution IS NULL OR resolution IN ('removed', 'corrected', 'restored')),
  CONSTRAINT profile_disputes_resolved_pair_chk
    CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_profile_disputes_profile ON profile_disputes (profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_disputes_open ON profile_disputes (created_at) WHERE resolved_at IS NULL;
