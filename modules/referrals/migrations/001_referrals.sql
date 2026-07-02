-- 001_referrals.sql
-- Cross-Platform Referral Network - canonical DDL (Build Spec v1.2, section 3).
-- Run identically on all four platform databases AFTER confirming the connection
-- target against DB_MAP.md. The topology is not clean: LAW prod lives in the
-- lawyer-intelligence-backend project (shinkansen), CBE in kind-transformation.
-- "Same SQL four times" must never mean "same target assumption four times".
--
-- This file is split into two sections:
--   SECTION A - module-owned NEW tables. Empty on creation, instant, idempotent.
--               Applied at boot by ensureReferralSchema() (schema.js).
--   SECTION B - additions to the existing professional table (cpa_profiles on ACC).
--               Touches a production table + builds a unique index. Reviewed and
--               run once alongside the referral_code backfill, NOT at boot.
--
-- Table names here reflect ACC (cpa_profiles / client_profiles). On LAW/INV the
-- professional/client table names differ - the shared module never hardcodes a
-- name; it reads config.PRO_TABLE / config.CLIENT_TABLE. This file is the ACC
-- instance of the migration; adjust the SECTION B table name per platform.

-- =====================================================================
-- SECTION A - module-owned tables (boot-safe, idempotent)
-- =====================================================================

-- 3.1 Referrals: one row per hand-off, on BOTH the sending and receiving platform.
CREATE TABLE IF NOT EXISTS network_referrals (
  id                SERIAL PRIMARY KEY,
  network_ref_id    UUID NOT NULL,                 -- same value on both platforms (idempotency key)
  direction         TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  source_platform   TEXT NOT NULL,                 -- 'ACC'|'LAW'|'INV'|'CBE'
  target_platform   TEXT NOT NULL,
  referrer_pro_id   INTEGER,                       -- local pro id when direction='outbound' (null for platform-originated)
  referrer_name     TEXT,                          -- denormalized for the receiving side
  referrer_email    TEXT,
  matched_pro_id    INTEGER,                       -- set on receiving platform once matched
  matched_client_profile_id INTEGER,              -- synthesized client_profiles row used for matching (receiving side)
  client_name       TEXT NOT NULL,
  client_email      TEXT NOT NULL,
  client_phone      TEXT,
  client_province   TEXT,
  need_category     TEXT NOT NULL,                 -- e.g. 'incorporation','exit_readiness','proceeds_management'
  need_notes        TEXT,                          -- referrer's context (client-visible; warn in UI)
  client_consented  BOOLEAN NOT NULL DEFAULT false,-- referrer attests client asked for the intro (CASL basis)
  consent_recorded_at TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'offered'
                    CHECK (status IN ('offered','accepted','declined','connected','converted','expired','cancelled')),
  match_attempts    INTEGER NOT NULL DEFAULT 0,    -- re-match counter (max 3, see sweeper)
  accept_deadline_at TIMESTAMPTZ,                  -- 48h window for the current matched pro
  converted_value_cents INTEGER,                   -- optional; subscription or engagement value if known
  expires_at        TIMESTAMPTZ,                   -- default now() + interval '30 days'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network_ref_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_network_referrals_network_ref_id ON network_referrals(network_ref_id);
CREATE INDEX IF NOT EXISTS idx_network_referrals_status ON network_referrals(status);
CREATE INDEX IF NOT EXISTS idx_network_referrals_referrer_pro_id ON network_referrals(referrer_pro_id);
CREATE INDEX IF NOT EXISTS idx_network_referrals_matched_pro_id ON network_referrals(matched_pro_id);
CREATE INDEX IF NOT EXISTS idx_network_referrals_target_platform ON network_referrals(target_platform);
CREATE INDEX IF NOT EXISTS idx_network_referrals_client_email ON network_referrals(client_email);
CREATE INDEX IF NOT EXISTS idx_network_referrals_created_at ON network_referrals(created_at);
-- Sweeper query support: open referrals whose accept window has elapsed.
CREATE INDEX IF NOT EXISTS idx_network_referrals_accept_deadline ON network_referrals(accept_deadline_at)
  WHERE status = 'offered';

-- 3.2 Referral events: append-only audit trail (compliance requirement - do not skip).
CREATE TABLE IF NOT EXISTS network_referral_events (
  id              SERIAL PRIMARY KEY,
  referral_id     INTEGER NOT NULL REFERENCES network_referrals(id),
  event_type      TEXT NOT NULL,     -- see EVENT_TYPES in service.js for the closed set
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_referral_events_referral_id ON network_referral_events(referral_id);
CREATE INDEX IF NOT EXISTS idx_network_referral_events_event_type ON network_referral_events(event_type);

-- 3.3 Referral credits: non-cash incentives ledger. 'pending_review' gates any
-- self-reported conversion behind an admin approval before Stripe touches money.
CREATE TABLE IF NOT EXISTS network_referral_credits (
  id              SERIAL PRIMARY KEY,
  pro_id          INTEGER NOT NULL,
  referral_id     INTEGER REFERENCES network_referrals(id),
  credit_type     TEXT NOT NULL CHECK (credit_type IN ('free_month','tier_boost_30d','priority_points')),
  amount          INTEGER NOT NULL DEFAULT 1,
  stripe_coupon_id TEXT,                           -- when applied to a subscription
  status          TEXT NOT NULL DEFAULT 'earned'
                  CHECK (status IN ('pending_review','earned','applied','expired','rejected')),
  review_note     TEXT,                            -- admin approve/reject reason
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  applied_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_referral_credits_pro_id ON network_referral_credits(pro_id);
CREATE INDEX IF NOT EXISTS idx_network_referral_credits_status ON network_referral_credits(status);

-- 4.3 Outbox: outbound network payloads written in the same txn as the referral,
-- flushed by a worker with a DB-atomic row claim (correct under >1 replica).
CREATE TABLE IF NOT EXISTS network_outbox (
  id SERIAL PRIMARY KEY,
  target_platform TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_outbox_due ON network_outbox(next_attempt_at)
  WHERE delivered_at IS NULL;

-- 6. Link attributions (Loop 2 recruiting). NOT referrals: referral_events.referral_id
-- is NOT NULL, so link-only attribution cannot live there.
CREATE TABLE IF NOT EXISTS network_link_attributions (
  id              SERIAL PRIMARY KEY,
  referral_code   TEXT NOT NULL,
  code_platform   TEXT NOT NULL,               -- prefix of the code
  recruit_type    TEXT NOT NULL CHECK (recruit_type IN ('professional','client')),
  recruit_id      INTEGER,                     -- local id of the new pro/lead
  recruit_email   TEXT,
  converted_paid  BOOLEAN NOT NULL DEFAULT false,
  converted_at    TIMESTAMPTZ,
  credit_id       INTEGER REFERENCES network_referral_credits(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_link_attributions_code ON network_link_attributions(referral_code);
CREATE INDEX IF NOT EXISTS idx_network_link_attributions_email ON network_link_attributions(recruit_email);

-- =====================================================================
-- SECTION B - professional-table additions (REVIEWED / GATED, not boot)
-- ACC table = cpa_profiles. Run once, reviewed, with the referral_code backfill.
-- ADD COLUMN IF NOT EXISTS is metadata-only; the UNIQUE index build is the part
-- that touches the table under load - schedule it deliberately, not at boot.
-- =====================================================================

ALTER TABLE cpa_profiles ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE cpa_profiles ADD COLUMN IF NOT EXISTS referrals_sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cpa_profiles ADD COLUMN IF NOT EXISTS referrals_converted_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cpa_profiles ADD COLUMN IF NOT EXISTS reciprocity_score NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE cpa_profiles ADD COLUMN IF NOT EXISTS network_badge TEXT;            -- null | 'connector' | 'network_trusted'
ALTER TABLE cpa_profiles ADD COLUMN IF NOT EXISTS attributed_referral_code TEXT; -- who recruited this pro

-- Build the unique index AFTER the backfill has populated distinct codes.
-- CONCURRENTLY avoids a long write lock (cannot run inside a txn block).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cpa_profiles_referral_code
  ON cpa_profiles(referral_code);
