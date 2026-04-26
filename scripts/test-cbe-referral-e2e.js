#!/usr/bin/env node
/**
 * End-to-end test of the ACC → CBE referral path.
 * - Inserts a temp CPA user + cpa_profile in ACC DB
 * - Generates a JWT signed with ACC's JWT_SECRET
 * - POSTs to /api/cpa/refer-to-cbe
 * - Verifies the cbe_referrals audit row exists in ACC DB
 * - Verifies the smes row exists in CBE DB with the right attribution
 * - Cleans up everything
 *
 * Required env: JWT_SECRET, ACC_DATABASE_URL, CBE_DATABASE_URL
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const ACC_BASE = process.env.ACC_BASE || 'https://canadaaccountants-backend-production-1d8f.up.railway.app';
const JWT_SECRET = process.env.JWT_SECRET;
const ACC_DB = process.env.ACC_DATABASE_URL;
const CBE_DB = process.env.CBE_DATABASE_URL;

if (!JWT_SECRET || !ACC_DB || !CBE_DB) {
  console.error('Required: JWT_SECRET, ACC_DATABASE_URL, CBE_DATABASE_URL');
  process.exit(1);
}

const TS = Date.now();
const CPA_EMAIL = `arthur+acc-cpa-test-${TS}@negotiateandwin.com`;
const SME_EMAIL = `arthur+sme-from-acc-${TS}@negotiateandwin.com`;

async function main() {
  const accPool = new Pool({ connectionString: ACC_DB, ssl: { rejectUnauthorized: false } });
  const cbePool = new Pool({ connectionString: CBE_DB, ssl: { rejectUnauthorized: false } });
  let pass = 0, fail = 0;
  const check = (label, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };

  let userId = null, smeId = null;

  try {
    console.log(`Test CPA: ${CPA_EMAIL}`);
    console.log(`Test SME: ${SME_EMAIL}`);

    // 1. Create temp user + cpa_profile in ACC
    const userInsert = await accPool.query(
      `INSERT INTO users (email, password_hash, user_type)
       VALUES ($1, 'fake-hash-test-only', 'CPA')
       RETURNING id`,
      [CPA_EMAIL]
    );
    userId = userInsert.rows[0].id;
    await accPool.query(
      `INSERT INTO cpa_profiles (cpa_id, user_id, first_name, last_name, email, firm_name, province, city)
       VALUES ($1, $2, 'Nicholas', 'Hanna', $3, 'Hanna CPA Toronto', 'ON', 'Toronto')`,
      [`test-${TS}`, userId, CPA_EMAIL]
    );
    check('Temp CPA created', !!userId, `userId=${userId}`);

    // 2. Generate JWT (matches /api/auth/login signing pattern)
    const token = jwt.sign(
      { userId, email: CPA_EMAIL, userType: 'CPA' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    check('JWT signed', !!token);

    // 3. POST referral to ACC backend
    const referralPayload = {
      client_first_name: 'Test',
      client_last_name: 'Owner',
      client_email: SME_EMAIL,
      client_company: 'Acme Test Co.',
      client_industry: 'manufacturing',
      client_province: 'ON',
      revenue_range: '$10M-$25M',
      referring_note: 'End-to-end ACC->CBE test — automated cleanup follows.',
    };
    const r = await fetch(`${ACC_BASE}/api/cpa/refer-to-cbe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(referralPayload),
    });
    const j = await r.json();
    check('HTTP 200 from ACC', r.status === 200, `status=${r.status} body=${JSON.stringify(j).substr(0,200)}`);
    check('Response.success = true', j.success === true);
    check('Response has sme_id', !!j.sme_id);
    check('Response was_new = true', j.was_new === true);
    smeId = j.sme_id;

    // 4. Verify cbe_referrals row in ACC DB
    const audit = await accPool.query(
      `SELECT * FROM cbe_referrals WHERE cpa_user_id = $1 ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    check('cbe_referrals audit row exists', audit.rows.length === 1);
    if (audit.rows[0]) {
      const a = audit.rows[0];
      check('audit.client_email matches', a.client_email === SME_EMAIL);
      check('audit.client_first_name = Test', a.client_first_name === 'Test');
      check('audit.cbe_sme_id matches response', String(a.cbe_sme_id) === String(smeId));
      check('audit.was_new = true', a.was_new === true);
      check('audit.cbe_response_status = 200', a.cbe_response_status === 200);
      check('audit.client_company set', a.client_company === 'Acme Test Co.');
      check('audit.referring_note set', !!a.referring_note);
    }

    // 5. Verify smes row in CBE DB has correct attribution
    const sme = await cbePool.query(`SELECT * FROM smes WHERE id = $1`, [smeId]);
    check('CBE smes row exists', sme.rows.length === 1);
    if (sme.rows[0]) {
      const s = sme.rows[0];
      check('CBE smes.email matches', s.email === SME_EMAIL);
      check('CBE smes.consent_basis = referral_from_advisor', s.consent_basis === 'referral_from_advisor');
      check('CBE smes.referring_platform = ACC', s.referring_platform === 'ACC');
      check('CBE smes.referring_user_id matches', String(s.referring_user_id) === String(userId));
      check('CBE smes.referring_user_email matches', s.referring_user_email === CPA_EMAIL);
      check('CBE smes.referring_user_name = Nicholas Hanna', s.referring_user_name === 'Nicholas Hanna');
      check('CBE smes.industry = manufacturing', s.industry === 'manufacturing');
      check('CBE smes.referred_at set', !!s.referred_at);
    }

    // 6. Idempotency: re-POST same payload, expect was_new=false
    const r2 = await fetch(`${ACC_BASE}/api/cpa/refer-to-cbe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(referralPayload),
    });
    const j2 = await r2.json();
    check('Idempotent re-POST returns 200', r2.status === 200);
    check('Idempotent re-POST sme_id matches', String(j2.sme_id) === String(smeId));
    check('Idempotent re-POST was_new = false', j2.was_new === false);

  } catch (err) {
    console.error('TEST EXCEPTION:', err.message);
    fail++;
  } finally {
    // Cleanup CBE
    if (smeId) {
      await cbePool.query(`DELETE FROM unsubscribe_tokens WHERE recipient_type='sme' AND recipient_id=$1`, [smeId]);
      await cbePool.query(`DELETE FROM smes WHERE id=$1`, [smeId]);
    }
    await cbePool.query(`DELETE FROM unsubscribes WHERE email=$1`, [SME_EMAIL]);

    // Cleanup ACC
    if (userId) {
      await accPool.query(`DELETE FROM cbe_referrals WHERE cpa_user_id = $1`, [userId]);
      await accPool.query(`DELETE FROM cpa_profiles WHERE user_id = $1`, [userId]);
      await accPool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    await accPool.end();
    await cbePool.end();

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail === 0 ? 0 : 1);
  }
}
main();
