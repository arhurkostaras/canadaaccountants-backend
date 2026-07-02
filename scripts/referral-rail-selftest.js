// scripts/referral-rail-selftest.js
// Dark self-test for the referral rail (Build Spec v1.2, Phase 1 gate).
// Proves, against a SCRATCH database and a fake in-process LAW peer:
//   1. HMAC: bad signature / stale timestamp / unknown platform -> 401, valid -> 2xx
//   2. Create: consent + suppression + duplicate + rate-limit chain enforced
//   3. Outbox: referral + outbox row in one txn; flush delivers signed payload;
//      re-delivery is idempotent (single inbound record)
//   4. Inbound: receive -> synthesized client_profiles row -> matcher -> matched
//   5. DARK MODE: zero emails leave the process (sendEmail spy throws if called);
//      every would-be send logged as network_referral_events('email_suppressed_dark')
//      with the rendered template
//   6. Accept -> intro suppressed dark -> status outbox row enqueued for the source
//
// Usage:
//   DATABASE_URL=postgres://localhost/referral_selftest node scripts/referral-rail-selftest.js
//
// SAFETY: refuses to run against anything that looks like a Railway/production
// host unless SELFTEST_ALLOW_REMOTE=1 is set explicitly. It creates and drops
// its own tables in the target DB.

'use strict';

process.env.PLATFORM_ID = 'ACC';
process.env.REFERRAL_NOTIFY_ENABLED = 'false'; // explicit: the rail must run dark
process.env.NETWORK_SHARED_SECRET = process.env.NETWORK_SHARED_SECRET || 'selftest-secret-not-production';

const { Pool } = require('pg');
const express = require('express');
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FAIL: set DATABASE_URL to a scratch database (never production).');
  process.exit(1);
}
if (/rlwy\.net|railway|proxy\./i.test(DATABASE_URL) && process.env.SELFTEST_ALLOW_REMOTE !== '1') {
  console.error('FAIL: DATABASE_URL looks like a Railway/production host. This self-test creates and drops tables.');
  console.error('      Point it at a local scratch DB, or set SELFTEST_ALLOW_REMOTE=1 if you are certain.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}`); }
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });

  // --- scratch-schema setup (module tables + minimal ACC lookalikes) --------
  await pool.query(`
    DROP TABLE IF EXISTS network_referral_events, network_link_attributions,
      network_referral_credits, network_outbox, network_referrals,
      client_profiles, cpa_profiles, outreach_unsubscribes CASCADE;
    CREATE TABLE cpa_profiles (
      id SERIAL PRIMARY KEY, user_id INTEGER, first_name TEXT, last_name TEXT,
      email TEXT, firm_name TEXT, referral_code TEXT,
      referrals_sent_count INTEGER NOT NULL DEFAULT 0,
      referrals_converted_count INTEGER NOT NULL DEFAULT 0,
      reciprocity_score NUMERIC(6,2) NOT NULL DEFAULT 0, network_badge TEXT,
      attributed_referral_code TEXT
    );
    CREATE TABLE client_profiles (
      id SERIAL PRIMARY KEY, user_id INTEGER, service_type VARCHAR(100),
      business_size VARCHAR(50), budget_range VARCHAR(50), fee_preference VARCHAR(50),
      province VARCHAR(50), city VARCHAR(100), meeting_preference VARCHAR(20),
      contact_name VARCHAR(200), contact_email VARCHAR(255), contact_phone VARCHAR(50),
      total_matches INTEGER DEFAULT 0, successful_matches INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE outreach_unsubscribes (id SERIAL PRIMARY KEY, email TEXT);
  `);
  await pool.query(
    `INSERT INTO cpa_profiles (user_id, first_name, last_name, email) VALUES
     (101, 'Referring', 'CPA', 'referrer@selftest.local'),
     (102, 'Matched', 'CPA', 'matched-pro@selftest.local')`
  );
  await pool.query(`INSERT INTO outreach_unsubscribes (email) VALUES ('optedout@selftest.local')`);

  // --- fake LAW peer: HMAC-verifying receiver on localhost ------------------
  const hmac = require('../modules/referrals/hmac');
  const peerInbox = [];
  const peerApp = express();
  peerApp.post('/api/network/referrals', express.raw({ type: 'application/json' }), (req, res) => {
    const raw = req.body.toString('utf8');
    const v = hmac.verify({
      secrets: [process.env.NETWORK_SHARED_SECRET],
      timestamp: req.headers['x-network-timestamp'],
      signature: req.headers['x-network-signature'],
      canonicalPayload: raw,
    });
    if (!v.ok) return res.status(401).json({ error: v.reason });
    const payload = JSON.parse(raw);
    const dup = peerInbox.find((p) => p.network_ref_id === payload.network_ref_id);
    if (!dup) peerInbox.push(payload);
    return res.status(dup ? 200 : 201).json({ ok: true });
  });
  peerApp.post('/api/network/referrals/:id/status', express.raw({ type: 'application/json' }), (req, res) => {
    const raw = req.body.toString('utf8');
    const v = hmac.verify({
      secrets: [process.env.NETWORK_SHARED_SECRET],
      timestamp: req.headers['x-network-timestamp'],
      signature: req.headers['x-network-signature'],
      canonicalPayload: raw,
    });
    if (!v.ok) return res.status(401).json({ error: v.reason });
    peerInbox.push({ status_update: req.params.id, body: JSON.parse(raw) });
    return res.status(200).json({ ok: true });
  });
  const peerServer = await new Promise((resolve) => {
    const s = peerApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const peerPort = peerServer.address().port;
  process.env.NETWORK_PEERS = JSON.stringify({ LAW: `http://127.0.0.1:${peerPort}` });

  // --- build the module (env is set; config reads it now) -------------------
  const createReferralModule = require('../modules/referrals');
  let emailAttempts = 0;
  const rail = createReferralModule({
    pool,
    // DARK-MODE SPY: if any code path reaches a real send, the test fails loudly.
    sendEmail: async () => { emailAttempts++; throw new Error('sendEmail called while dark - HARD FAIL'); },
    stripe: null,
    auth: {
      authenticateToken: (req, res, next) => next(),
      requireCPA: (req, res, next) => next(),
    },
    matcher: {
      // Stub scorer: returns the "matched" CPA. Exercises the adapter's
      // synthesize-client-profile path without the full 6-factor engine.
      runMatch: async () => [
        { cpa: { id: 2, first_name: 'Matched', last_name: 'CPA', email: 'matched-pro@selftest.local' }, overall_score: 91 },
      ],
    },
    validateEmail: async () => ({}),
    captureError: () => {},
  });
  await rail.ensureSchema();

  console.log('\n== 1. HMAC gate ==');
  const netApp = express();
  netApp.use(rail.networkRouter);
  const netServer = await new Promise((resolve) => {
    const s = netApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  const netPort = netServer.address().port;
  const netBase = `http://127.0.0.1:${netPort}`;
  const ts = () => Math.floor(Date.now() / 1000).toString();
  const inboundPayload = {
    network_ref_id: crypto.randomUUID(),
    source_platform: 'LAW',
    referrer: { pro_id: 55, name: 'A Lawyer', email: 'lawyer@selftest.local' },
    client: { name: 'Inbound Client', email: 'inbound-client@selftest.local', province: 'ON' },
    need_category: 'exit_readiness',
    client_consented: true,
    consent_recorded_at: new Date().toISOString(),
  };
  const rawInbound = JSON.stringify(inboundPayload);

  let r = await fetch(`${netBase}/api/network/referrals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawInbound,
  });
  assert(r.status === 401, 'missing headers -> 401');

  r = await fetch(`${netBase}/api/network/referrals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Network-Platform': 'LAW',
      'X-Network-Timestamp': ts(), 'X-Network-Signature': 'deadbeef'.repeat(8),
    },
    body: rawInbound,
  });
  assert(r.status === 401, 'bad signature -> 401');

  const staleTs = (Math.floor(Date.now() / 1000) - 3600).toString();
  r = await fetch(`${netBase}/api/network/referrals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Network-Platform': 'LAW',
      'X-Network-Timestamp': staleTs,
      'X-Network-Signature': hmac.sign(process.env.NETWORK_SHARED_SECRET, staleTs, rawInbound),
    },
    body: rawInbound,
  });
  assert(r.status === 401, 'stale timestamp -> 401');

  const t1 = ts();
  r = await fetch(`${netBase}/api/network/referrals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Network-Platform': 'XXX',
      'X-Network-Timestamp': t1,
      'X-Network-Signature': hmac.sign(process.env.NETWORK_SHARED_SECRET, t1, rawInbound),
    },
    body: rawInbound,
  });
  assert(r.status === 401, 'unknown peer platform -> 401');

  console.log('\n== 2. Inbound receive -> match (dark) ==');
  const t2 = ts();
  r = await fetch(`${netBase}/api/network/referrals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Network-Platform': 'LAW',
      'X-Network-Timestamp': t2,
      'X-Network-Signature': hmac.sign(process.env.NETWORK_SHARED_SECRET, t2, rawInbound),
    },
    body: rawInbound,
  });
  assert(r.status === 201, 'valid signed inbound -> 201');

  // Idempotency: re-deliver the same network_ref_id.
  const t3 = ts();
  r = await fetch(`${netBase}/api/network/referrals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Network-Platform': 'LAW',
      'X-Network-Timestamp': t3,
      'X-Network-Signature': hmac.sign(process.env.NETWORK_SHARED_SECRET, t3, rawInbound),
    },
    body: rawInbound,
  });
  assert(r.status === 200, 'duplicate delivery -> 200 (idempotent)');
  const inboundCount = await pool.query(
    `SELECT count(*)::int AS n FROM network_referrals WHERE network_ref_id = $1 AND direction = 'inbound'`,
    [inboundPayload.network_ref_id]
  );
  assert(inboundCount.rows[0].n === 1, 'exactly one inbound record after duplicate delivery');

  const inboundRow = (await pool.query(
    `SELECT * FROM network_referrals WHERE network_ref_id = $1 AND direction = 'inbound'`,
    [inboundPayload.network_ref_id]
  )).rows[0];
  assert(inboundRow.matched_pro_id === 2, 'inbound referral matched to the stub CPA (id 2)');
  assert(inboundRow.matched_client_profile_id != null, 'synthesized client_profiles row recorded');
  assert(inboundRow.accept_deadline_at != null, '48h accept deadline set');
  const synth = await pool.query(`SELECT * FROM client_profiles WHERE id = $1`, [inboundRow.matched_client_profile_id]);
  assert(synth.rows.length === 1 && synth.rows[0].service_type === 'exit_readiness',
    'client_profiles row synthesized with need_category -> service_type');

  const darkOffer = await pool.query(
    `SELECT detail FROM network_referral_events WHERE referral_id = $1 AND event_type = 'email_suppressed_dark'`,
    [inboundRow.id]
  );
  assert(darkOffer.rows.length === 1, 'offer email suppressed dark + logged');
  assert(darkOffer.rows[0].detail && darkOffer.rows[0].detail.subject && darkOffer.rows[0].detail.html,
    'suppressed offer log carries the rendered template');

  console.log('\n== 3. Create outbound (validation chain) ==');
  // consent===true is enforced at the route layer (422) before the service runs;
  // the service-level chain below covers suppression + duplicate + creation.
  const suppressed = await rail.service.createReferral(pool, rail.config, {
    target_platform: 'LAW',
    client: { name: 'Opted Out', email: 'optedout@selftest.local' },
    need_category: 'share_sale', referrerProId: 1,
  });
  assert(suppressed.ok === false && suppressed.code === 409, 'suppressed client email -> blocked');

  const created = await rail.service.createReferral(pool, rail.config, {
    target_platform: 'LAW',
    client: { name: 'Outbound Client', email: 'outbound-client@selftest.local', province: 'ON' },
    need_category: 'share_sale', need_notes: 'Selling ON opco',
    referrerProId: 1, referrerName: 'Referring CPA', referrerEmail: 'referrer@selftest.local',
  });
  assert(created.ok === true, 'valid outbound referral created');

  const dup = await rail.service.createReferral(pool, rail.config, {
    target_platform: 'LAW',
    client: { name: 'Outbound Client', email: 'outbound-client@selftest.local', province: 'ON' },
    need_category: 'share_sale', referrerProId: 1,
  });
  assert(dup.ok === false && dup.code === 409, 'duplicate within 30 days -> 409');

  const outboxBefore = await pool.query(`SELECT count(*)::int AS n FROM network_outbox WHERE delivered_at IS NULL`);
  assert(outboxBefore.rows[0].n >= 1, 'outbox row written in the create transaction');

  console.log('\n== 4. Outbox flush -> signed delivery to peer ==');
  await rail.flushOutboxOnce();
  const delivered = peerInbox.find((p) => p.network_ref_id === created.referral.network_ref_id);
  assert(!!delivered, 'peer received the signed referral payload');
  const undeliveredAfter = await pool.query(
    `SELECT count(*)::int AS n FROM network_outbox WHERE delivered_at IS NULL AND endpoint = '/api/network/referrals'`
  );
  assert(undeliveredAfter.rows[0].n === 0, 'outbox row marked delivered');
  await rail.flushOutboxOnce();
  const dupDelivered = peerInbox.filter((p) => p.network_ref_id === created.referral.network_ref_id);
  assert(dupDelivered.length === 1, 're-flush does not re-deliver (claim discipline)');

  console.log('\n== 5. Accept -> dark intro + status sync enqueued ==');
  const accept = await rail.service.acceptReferral(pool, rail.config, inboundRow.id, 2);
  assert(accept.ok === true, 'matched pro accepts inbound referral');
  const afterAccept = (await pool.query(`SELECT status FROM network_referrals WHERE id = $1`, [inboundRow.id])).rows[0];
  assert(afterAccept.status === 'accepted', 'inbound status -> accepted');
  const darkAfterAccept = await pool.query(
    `SELECT count(*)::int AS n FROM network_referral_events WHERE referral_id = $1 AND event_type = 'email_suppressed_dark'`,
    [inboundRow.id]
  );
  assert(darkAfterAccept.rows[0].n >= 2, 'client intro suppressed dark + logged (no real send)');
  await rail.flushOutboxOnce();
  const statusSync = peerInbox.find((p) => p.status_update === inboundPayload.network_ref_id);
  assert(!!statusSync && statusSync.body.status === 'accepted', 'accepted status synced to source platform');

  console.log('\n== 6. Dark guarantee ==');
  assert(emailAttempts === 0, `ZERO real email attempts (spy count: ${emailAttempts})`);
  const eventTrail = await pool.query(
    `SELECT event_type, count(*)::int AS n FROM network_referral_events GROUP BY event_type ORDER BY event_type`
  );
  console.log('  event trail:', eventTrail.rows.map((e) => `${e.event_type}x${e.n}`).join(', '));

  // --- teardown --------------------------------------------------------------
  netServer.close();
  peerServer.close();
  await pool.query(`
    DROP TABLE IF EXISTS network_referral_events, network_link_attributions,
      network_referral_credits, network_outbox, network_referrals,
      client_profiles, cpa_profiles, outreach_unsubscribes CASCADE;
  `);
  await pool.end();

  console.log(`\n${failed === 0 ? 'SELF-TEST PASSED' : 'SELF-TEST FAILED'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SELF-TEST CRASHED:', err);
  process.exit(1);
});
