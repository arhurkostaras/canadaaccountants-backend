// modules/referrals/schema.js
// Boot-time creation of the module-owned tables (SECTION A of
// migrations/001_referrals.sql). These are empty on creation and instant, so
// they follow the codebase's inline CREATE TABLE IF NOT EXISTS boot convention.
//
// The cpa_profiles ALTER + referral_code backfill (SECTION B) is NOT here - it
// touches a production table and is run once, reviewed, per the bulk-op rule.
//
// Keep this DDL in sync with SECTION A of 001_referrals.sql (that file is the
// canonical reviewed artifact; this is the boot applier).

'use strict';

const DDL = `
CREATE TABLE IF NOT EXISTS network_referrals (
  id                SERIAL PRIMARY KEY,
  network_ref_id    UUID NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  source_platform   TEXT NOT NULL,
  target_platform   TEXT NOT NULL,
  referrer_pro_id   INTEGER,
  referrer_name     TEXT,
  referrer_email    TEXT,
  matched_pro_id    INTEGER,
  matched_client_profile_id INTEGER,
  client_name       TEXT NOT NULL,
  client_email      TEXT NOT NULL,
  client_phone      TEXT,
  client_province   TEXT,
  need_category     TEXT NOT NULL,
  need_notes        TEXT,
  client_consented  BOOLEAN NOT NULL DEFAULT false,
  consent_recorded_at TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'offered'
                    CHECK (status IN ('offered','accepted','declined','connected','converted','expired','cancelled')),
  match_attempts    INTEGER NOT NULL DEFAULT 0,
  accept_deadline_at TIMESTAMPTZ,
  converted_value_cents INTEGER,
  expires_at        TIMESTAMPTZ,
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
CREATE INDEX IF NOT EXISTS idx_network_referrals_accept_deadline ON network_referrals(accept_deadline_at) WHERE status = 'offered';

CREATE TABLE IF NOT EXISTS network_referral_events (
  id              SERIAL PRIMARY KEY,
  referral_id     INTEGER NOT NULL REFERENCES network_referrals(id),
  event_type      TEXT NOT NULL,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_referral_events_referral_id ON network_referral_events(referral_id);
CREATE INDEX IF NOT EXISTS idx_network_referral_events_event_type ON network_referral_events(event_type);

CREATE TABLE IF NOT EXISTS network_referral_credits (
  id              SERIAL PRIMARY KEY,
  pro_id          INTEGER NOT NULL,
  referral_id     INTEGER REFERENCES network_referrals(id),
  credit_type     TEXT NOT NULL CHECK (credit_type IN ('free_month','tier_boost_30d','priority_points')),
  amount          INTEGER NOT NULL DEFAULT 1,
  stripe_coupon_id TEXT,
  status          TEXT NOT NULL DEFAULT 'earned'
                  CHECK (status IN ('pending_review','earned','applied','expired','rejected')),
  review_note     TEXT,
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  applied_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_referral_credits_pro_id ON network_referral_credits(pro_id);
CREATE INDEX IF NOT EXISTS idx_network_referral_credits_status ON network_referral_credits(status);

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
CREATE INDEX IF NOT EXISTS idx_network_outbox_due ON network_outbox(next_attempt_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS network_link_attributions (
  id              SERIAL PRIMARY KEY,
  referral_code   TEXT NOT NULL,
  code_platform   TEXT NOT NULL,
  recruit_type    TEXT NOT NULL CHECK (recruit_type IN ('professional','client')),
  recruit_id      INTEGER,
  recruit_email   TEXT,
  converted_paid  BOOLEAN NOT NULL DEFAULT false,
  converted_at    TIMESTAMPTZ,
  credit_id       INTEGER REFERENCES network_referral_credits(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_link_attributions_code ON network_link_attributions(referral_code);
CREATE INDEX IF NOT EXISTS idx_network_link_attributions_email ON network_link_attributions(recruit_email);
`;

async function ensureReferralSchema(pool) {
  await pool.query(DDL);
  console.log('[referrals] module schema ensured (new tables only; cpa_profiles ALTER is gated)');
}

module.exports = { ensureReferralSchema, DDL };
