// modules/referrals/config.js
// Per-app configuration for the referral rail. One file, deployed to all four
// platforms; process.env.PLATFORM_ID selects the active profile. Shared-module
// code reads table names through this config and never hardcodes them.
//
// Confirmed against the ACC repo: PRO_TABLE=cpa_profiles, CLIENT_TABLE=client_profiles,
// SUPPRESSION_TABLE=outreach_unsubscribes. LAW/INV/CBE entries are marked TODO where
// the real table name still needs an in-repo check on that platform.

'use strict';

// Static, non-secret per-platform facts.
const PLATFORMS = {
  ACC: {
    PLATFORM_ID: 'ACC',
    PLATFORM_NAME: 'CanadaAccountants',
    PLATFORM_DOMAIN: 'https://canadaaccountants.app',
    PRO_NOUN: 'CPA',
    PRO_TABLE: 'cpa_profiles',            // confirmed
    CLIENT_TABLE: 'client_profiles',      // confirmed
    SUPPRESSION_TABLE: 'outreach_unsubscribes', // confirmed
    SUPPRESSION_EMAIL_COL: 'email',       // confirmed on outreach_unsubscribes
    ACCENT: '#1e3a8a',
    REFER_TARGETS: ['LAW', 'INV', 'CBE'],
    INBOUND_LEAD_HANDLER: 'standard',     // 'standard' | 'private_intake'
    HAS_SUBSCRIPTIONS: true,
    CREDIT_ON_CONVERSION: 'free_month',
  },
  LAW: {
    PLATFORM_ID: 'LAW',
    PLATFORM_NAME: 'CanadaLawyers',
    PLATFORM_DOMAIN: 'https://canadalawyers.app',
    PRO_NOUN: 'lawyer',
    PRO_TABLE: 'TODO_verify_law_pro_table',       // verify in the LAW repo before migrating
    CLIENT_TABLE: 'TODO_verify_law_client_table',
    SUPPRESSION_TABLE: 'outreach_unsubscribes',   // LAW prod confirmed to have outreach_unsubscribes (DB_MAP)
    SUPPRESSION_EMAIL_COL: 'email',
    ACCENT: '#2563eb',
    REFER_TARGETS: ['ACC', 'INV', 'CBE'],
    INBOUND_LEAD_HANDLER: 'standard',
    HAS_SUBSCRIPTIONS: true,
    CREDIT_ON_CONVERSION: 'free_month',
  },
  INV: {
    PLATFORM_ID: 'INV',
    PLATFORM_NAME: 'CanadaInvesting',
    PLATFORM_DOMAIN: 'https://canadainvesting.app',
    PRO_NOUN: 'advisor',
    PRO_TABLE: 'TODO_verify_inv_pro_table',
    CLIENT_TABLE: 'TODO_verify_inv_client_table',
    SUPPRESSION_TABLE: 'outreach_unsubscribes',   // INV prod confirmed (DB_MAP)
    SUPPRESSION_EMAIL_COL: 'email',
    ACCENT: '#0e7490',
    REFER_TARGETS: ['ACC', 'LAW', 'CBE'],
    INBOUND_LEAD_HANDLER: 'standard',
    HAS_SUBSCRIPTIONS: true,
    CREDIT_ON_CONVERSION: 'free_month',
  },
  CBE: {
    PLATFORM_ID: 'CBE',
    PLATFORM_NAME: 'Canada Business Exits',
    PLATFORM_DOMAIN: 'https://canadabusinessexits.app',
    PRO_NOUN: 'M&A banker',
    PRO_TABLE: 'bankers',                 // confirmed (652 rows, DB_MAP)
    CLIENT_TABLE: 'TODO_verify_cbe_owner_intake_table',
    SUPPRESSION_TABLE: 'unsubscribes',    // CBE prod uses 'unsubscribes' per DB_MAP - verify column
    SUPPRESSION_EMAIL_COL: 'email',
    ACCENT: '#7a5c2e',
    REFER_TARGETS: ['ACC', 'LAW', 'INV'],
    INBOUND_LEAD_HANDLER: 'private_intake', // NDA-first, section 10.4
    HAS_SUBSCRIPTIONS: false,             // no subscriptions -> no free_month credits
    CREDIT_ON_CONVERSION: null,
  },
};

const PLATFORM_ID = process.env.PLATFORM_ID || 'ACC';
const platform = PLATFORMS[PLATFORM_ID];
if (!platform) {
  throw new Error(
    `[referrals] Unknown PLATFORM_ID='${PLATFORM_ID}'. Expected one of: ${Object.keys(PLATFORMS).join(', ')}`
  );
}

// Peer registry from env (JSON map of platform -> base URL). Falls back to the
// known public apexes so a missing env var does not silently disable delivery.
function parsePeers() {
  const raw = process.env.NETWORK_PEERS;
  if (!raw) {
    return {
      ACC: PLATFORMS.ACC.PLATFORM_DOMAIN,
      LAW: PLATFORMS.LAW.PLATFORM_DOMAIN,
      INV: PLATFORMS.INV.PLATFORM_DOMAIN,
      CBE: PLATFORMS.CBE.PLATFORM_DOMAIN,
    };
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Config error is loud: a bad NETWORK_PEERS means no cross-platform delivery.
    console.error('[referrals] NETWORK_PEERS is not valid JSON, falling back to apex defaults:', err.message);
    return {
      ACC: PLATFORMS.ACC.PLATFORM_DOMAIN,
      LAW: PLATFORMS.LAW.PLATFORM_DOMAIN,
      INV: PLATFORMS.INV.PLATFORM_DOMAIN,
      CBE: PLATFORMS.CBE.PLATFORM_DOMAIN,
    };
  }
}

// Notify gating (section 11.0). Default OFF. The rail runs fully dark until a
// platform is explicitly enabled in writing. ACC additionally sits behind the
// professional-contact moratorium (2026-06-10) and must not be flipped on
// without Arthur's written lift, regardless of this flag.
const NOTIFY_ENABLED = String(process.env.REFERRAL_NOTIFY_ENABLED || 'false').toLowerCase() === 'true';

module.exports = {
  ...platform,
  PLATFORMS,
  peers: parsePeers(),
  NOTIFY_ENABLED,
  // Secrets / tunables (env-driven, reused across platforms).
  NETWORK_SHARED_SECRET: process.env.NETWORK_SHARED_SECRET || '',
  NETWORK_SHARED_SECRET_NEXT: process.env.NETWORK_SHARED_SECRET_NEXT || '', // rotation window (section 14)
  BOOST_WEIGHT: parseInt(process.env.REFERRAL_BOOST_WEIGHT || '5', 10),     // Phase 3 only
  MAX_CREDITS_PER_YEAR: parseInt(process.env.MAX_CREDITS_PER_YEAR || '3', 10),
  EXPIRY_DAYS: parseInt(process.env.REFERRAL_EXPIRY_DAYS || '30', 10),
  ACCEPT_WINDOW_HOURS: 48,
  MAX_MATCH_ATTEMPTS: 3,
  MAX_OUTBOUND_PER_DAY: 10,
  DUPLICATE_WINDOW_DAYS: 30,
  STRIPE_REFERRAL_COUPON: process.env.STRIPE_REFERRAL_COUPON || 'REFERRAL_FREE_MONTH',
};
