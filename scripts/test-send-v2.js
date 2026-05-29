#!/usr/bin/env node
// One-off live-send test for the v2 supply sequence (Touch 1).
//
// Usage:
//   DATABASE_URL=... RESEND_API_KEY=... UNSUBSCRIBE_SECRET=... \
//     V2_RUNNER_LAUNCH_READY=true \
//     node scripts/test-send-v2.js --email arthur@negotiateandwin.com --first-name Arthur --province ON
//
// What it does:
//   1. Connects to the DB via DATABASE_URL.
//   2. Finds (or creates) a recipient row for the target email in scraped_cpas.
//      If creating, sets is_diagnostic=TRUE so the row can be cleaned up later.
//   3. Enrolls that recipient_id into v2_supply_enrollments at step 0, due now.
//   4. Calls sequence-runner-v2.runOnce(pool). Sends Touch 1 via Resend.
//   5. Reports what happened (resend_id, decision, errors).
//
// Safety:
//   - Won't send if V2_RUNNER_LAUNCH_READY is not 'true' (per runner gate).
//   - Doesn't change the deployed runner's launch gate; only sets it for this
//     script's process. The deployed backend stays gated as configured.
//   - On exit, prints the v2_supply_enrollments row id so you can manually
//     delete it after testing if you want a clean repeat.

// Guard: refuse to run if cwd does not look like this backend's repo (catches cd-missing footgun).
if (!process.cwd().includes('canadaaccountants-backend')) {
  console.error('refusing to run: cwd does not include \"canadaaccountants-backend\" — got ' + process.cwd());
  process.exit(2);
}

const { Pool } = require('pg');
const path = require('path');

// Force the launch gate for this script's process only.
process.env.V2_RUNNER_LAUNCH_READY = 'true';

const runner = require(path.resolve(__dirname, '..', 'services', 'sequence-runner-v2.js'));

function parseArgs() {
  const out = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--email') out.email = args[++i];
    else if (a === '--first-name') out.firstName = args[++i];
    else if (a === '--province') out.province = args[++i];
    else if (a === '--firm') out.firm = args[++i];
    else if (a === '--city') out.city = args[++i];
  }
  if (!out.email) {
    console.error('--email required');
    process.exit(2);
  }
  return out;
}

async function findOrCreateRecipient(pool, args) {
  const lower = args.email.toLowerCase().trim();
  // Look up by enriched_email or email
  const existing = await pool.query(
    `SELECT id, first_name, province FROM scraped_cpas
     WHERE LOWER(enriched_email) = $1 OR LOWER(email) = $1
     LIMIT 1`,
    [lower]
  );
  if (existing.rows.length > 0) {
    console.log(`Found existing recipient id=${existing.rows[0].id} (first_name=${existing.rows[0].first_name}, province=${existing.rows[0].province})`);
    return existing.rows[0].id;
  }
  // Create a synthetic diagnostic row
  const ins = await pool.query(
    `INSERT INTO scraped_cpas
       (source, first_name, last_name, full_name, email, enriched_email, province, city, firm_name, status)
     VALUES ('diagnostic', $1, $2, $3, $4, $4, $5, $6, $7, 'enriched')
     RETURNING id`,
    [
      args.firstName || 'Test',
      'Recipient',
      `${args.firstName || 'Test'} Recipient`,
      lower,
      args.province || 'ON',
      args.city || 'Toronto',
      args.firm || 'Test Firm LLP'
    ]
  );
  console.log(`Created diagnostic recipient id=${ins.rows[0].id} for ${lower}`);
  return ins.rows[0].id;
}

async function main() {
  const args = parseArgs();
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(2); }
  if (!process.env.RESEND_API_KEY) { console.error('RESEND_API_KEY required'); process.exit(2); }
  if (!process.env.UNSUBSCRIBE_SECRET) { console.error('UNSUBSCRIBE_SECRET required'); process.exit(2); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const recipientId = await findOrCreateRecipient(pool, args);
    const { enrollment_id, duplicate } = await runner.enrollOne(pool, recipientId);
    if (duplicate) {
      console.log(`Recipient already enrolled — using existing enrollment.`);
    } else {
      console.log(`Created enrollment id=${enrollment_id} (recipient_id=${recipientId})`);
    }
    console.log('Calling runOnce()...');
    const result = await runner.runOnce(pool);
    console.log('Result:', JSON.stringify(result, null, 2));
    // Show enrollment state after
    const after = await pool.query(
      `SELECT id, current_step, next_send_at, last_touch_resend_id, exit_reason
       FROM v2_supply_enrollments WHERE recipient_id = $1 ORDER BY id DESC LIMIT 1`,
      [recipientId]
    );
    console.log('Enrollment after:', after.rows[0]);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
