// Render-test verification: exercises the v2 sequence runner's renderTouch
// against every active email_template × 3 sampled recipients.
//
// Fails loud (exit 1) if any orphan {{...}} tag remains after substitution
// or if renderTouch returns ok:false for any combination.
//
// REQUIRED before flipping V2_RUNNER_LAUNCH_READY=true. CI-style gate.
//
// Usage:
//   DATABASE_URL=postgresql://... UNSUBSCRIBE_SECRET=... node scripts/render-test-all.js
//
// Set PGSSL=true to enable rejectUnauthorized:false (production via public
// proxy). Internal Railway DB usually does not need this.

const { Pool } = require('pg');
const runner = require('../services/sequence-runner-v2');
const { scanForOrphans } = require('../services/render-engine');

function die(msg, code = 2) {
  console.error(`render-test: ${msg}`);
  process.exit(code);
}

if (!process.env.DATABASE_URL) die('DATABASE_URL must be set');
if (!process.env.UNSUBSCRIBE_SECRET || process.env.UNSUBSCRIBE_SECRET.length < 16) {
  die('UNSUBSCRIBE_SECRET must be set (>=16 chars)');
}
if (!process.env.CASL_PHYSICAL_ADDRESS) {
  // CASL footer is appended after render; an empty address would produce a
  // visibly wrong footer. Require it explicit so test mirrors production.
  process.env.CASL_PHYSICAL_ADDRESS = '1012-728 Yates Street, Victoria, BC V8W 1L4, Canada';
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
});

async function discoverRecipientTable() {
  for (const t of ['scraped_lawyers', 'scraped_cpas', 'scraped_advisors', 'bankers', 'scraped_bankers']) {
    const r = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name=$1 LIMIT 1`, [t]);
    if (r.rows.length) return t;
  }
  return null;
}

async function sampleRecipients(table, n) {
  // Find which email columns exist (varies by platform). Treat empty string
  // as null via NULLIF so we only sample recipients with a usable email.
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  const colNames = cols.rows.map(r => r.column_name);
  const emailCols = ['enriched_email', 'email', 'banker_email', 'partner_email'].filter(c => colNames.includes(c));
  if (emailCols.length === 0) die(`no email column found on ${table}`);
  const emailExpr = `COALESCE(${emailCols.map(c => `NULLIF(${c}, '')`).join(', ')})`;
  const provinceFilter = colNames.includes('province')
    ? `AND province IS NOT NULL AND province <> ''`
    : '';
  const r = await pool.query(
    `SELECT id, first_name, full_name, ${colNames.includes('province') ? 'province' : "NULL AS province"}, ${emailExpr} AS test_email
     FROM ${table}
     WHERE first_name IS NOT NULL AND first_name <> ''
       ${provinceFilter}
       AND ${emailExpr} IS NOT NULL
     ORDER BY random()
     LIMIT $1`,
    [n]
  );
  return r.rows;
}

(async () => {
  const table = await discoverRecipientTable();
  if (!table) die('no recipient table found (looked for scraped_lawyers/cpas/advisors/bankers)');
  console.log(`recipient table: ${table}`);

  const recipients = await sampleRecipients(table, 3);
  if (recipients.length === 0) die(`no recipients found in ${table} with first_name+province`);
  console.log(`sampled ${recipients.length} recipients:`);
  for (const r of recipients) console.log(`  id=${r.id} first_name=${r.first_name} province=${r.province}`);

  const tpl = await pool.query(
    `SELECT touch_number, variant FROM email_template ORDER BY touch_number, variant`
  );
  if (tpl.rows.length === 0) die('no templates in email_template');
  console.log(`templates: ${tpl.rows.length}`);

  let total = 0, failures = 0;
  for (const t of tpl.rows) {
    for (const recipient of recipients) {
      total += 1;
      const fakeEnrollment = {
        id: `TEST-T${t.touch_number}-${t.variant}-${recipient.id}`,
        recipient_id: recipient.id,
        recipient_email: 'render-test@example.invalid',
        current_step: t.touch_number - 1
      };

      let rendered;
      try {
        rendered = await runner.renderTouch(pool, fakeEnrollment, t.touch_number);
      } catch (err) {
        console.log(`\n==== T${t.touch_number}/${t.variant} recipient=${recipient.id} (${recipient.first_name}, ${recipient.province}) ====`);
        console.log(`  ✗ THREW: ${err.message}`);
        failures += 1;
        continue;
      }

      console.log(`\n==== T${t.touch_number}/${t.variant} recipient=${recipient.id} (${recipient.first_name}, ${recipient.province}) ====`);
      if (!rendered.ok) {
        console.log(`  ✗ render FAILED: ${rendered.reason}`);
        failures += 1;
        continue;
      }

      const orphans = scanForOrphans({ subject: rendered.subject, text: rendered.text, html: rendered.html });
      console.log(`  SUBJECT: ${rendered.subject}`);
      const bodyPreview = (rendered.text || '').substring(0, 280).split('\n').join('\n    ');
      console.log(`  BODY (text, ${(rendered.text || '').length} chars, first 280):`);
      console.log(`    ${bodyPreview}`);
      if (orphans.length > 0) {
        console.log(`  ✗ ORPHAN TAGS: ${orphans.join(', ')}`);
        failures += 1;
      } else {
        console.log(`  ✓ no orphan tags`);
      }
    }
  }

  console.log(`\n========\ntotal: ${total} renders. failures: ${failures}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('render-test fatal:', err);
  process.exit(3);
});
