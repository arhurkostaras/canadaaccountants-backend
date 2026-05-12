#!/usr/bin/env node
// Enroll a cohort of ACC recipients into the v2 supply sequence.
//
// Usage:
//   DATABASE_URL=... node scripts/enroll-cohort.js --limit 200 --send-at "2026-05-11T13:00:00Z"
//
// Args:
//   --limit N            Max recipients to enroll. Required.
//   --send-at <ISO>      next_send_at for all enrolled. Default: NOW().
//   --province <code>    Restrict to province (e.g., ON). Optional.
//   --dry-run            Preview the SELECT only — no INSERT.
//
// Selection criteria (LAW):
//   - enriched_email IS NOT NULL (something to send to)
//   - status IN ('enriched', 'contacted')  (don't re-target raw/invalid rows)
//   - email NOT IN outreach_unsubscribes
//   - id NOT IN v2_supply_enrollments  (don't double-enroll)
//   - is_diagnostic IS NOT TRUE  (skip test rows)
//   - claim_status != 'claimed' OR claim_status IS NULL
//
// Stagger logic:
//   All enrolled rows share the same next_send_at. The runner picks up 50 per
//   5-min cycle, so sends ramp at ~600/hour. For larger cohorts (>1000), this
//   spreads sends across the day naturally.

// Guard: refuse to run if cwd does not look like this backend's repo (catches cd-missing footgun).
if (!process.cwd().includes('canadaaccountants-backend')) {
  console.error('refusing to run: cwd does not include \"canadaaccountants-backend\" — got ' + process.cwd());
  process.exit(2);
}

const { Pool } = require('pg');
const path = require('path');

const PLATFORM = 'acc';
const SEQUENCE_NAME = 'supply_v2_7touch';
const RECIPIENT_TABLE = 'scraped_cpas';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit') out.limit = parseInt(args[++i], 10);
    else if (a === '--send-at') out.sendAt = args[++i];
    else if (a === '--province') out.province = args[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  if (!out.limit || out.limit < 1) {
    console.error('--limit N (positive integer) required');
    process.exit(2);
  }
  if (out.sendAt && isNaN(Date.parse(out.sendAt))) {
    console.error('--send-at must be a valid ISO 8601 timestamp');
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(2); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const provinceFilter = args.province ? `AND p.province = $${2}` : '';
    const params = args.province ? [args.limit, args.province] : [args.limit];
    // ZB filter: exclude known-bad statuses. 'valid' + 'unknown' + unvalidated
    // are sendable; 'invalid', 'do_not_mail', 'catch-all' are excluded.
    // DISTINCT ON deduplicates by lowercased email so the same inbox is never
    // enrolled twice (CPAs often appear in multiple provincial CPA directories
    // with the same enriched email — 32% duplication rate observed pre-launch).
    const sql = `
      WITH ranked AS (
        SELECT DISTINCT ON (LOWER(p.enriched_email))
          p.id, p.first_name, p.province, p.enriched_email, p.email
        FROM ${RECIPIENT_TABLE} p
        LEFT JOIN email_validations v ON LOWER(v.email) = LOWER(p.enriched_email)
        WHERE p.enriched_email IS NOT NULL
          AND p.status IN ('enriched', 'contacted')
          AND COALESCE(p.is_misclassified, FALSE) = FALSE
          AND (p.claim_status IS NULL OR p.claim_status != 'claimed')
          AND (v.status IS NULL OR v.status IN ('valid', 'unknown'))
          AND LOWER(p.enriched_email) NOT IN (SELECT LOWER(email) FROM outreach_unsubscribes)
          AND LOWER(p.enriched_email) NOT IN (
            SELECT LOWER(recipient_email) FROM v2_supply_enrollments
            WHERE platform = '${PLATFORM}' AND sequence_name = '${SEQUENCE_NAME}'
          )
          ${provinceFilter}
        ORDER BY LOWER(p.enriched_email), p.id ASC
      )
      SELECT * FROM ranked ORDER BY id ASC LIMIT $1`;
    const candidates = await pool.query(sql, params);
    console.log(`Selected ${candidates.rows.length} candidate recipients (limit=${args.limit}${args.province ? `, province=${args.province}` : ''})`);
    if (candidates.rows.length === 0) {
      console.log('No candidates found. Exiting.');
      return;
    }
    console.log(`Sample (first 3):`);
    for (const r of candidates.rows.slice(0, 3)) {
      console.log(`  id=${r.id} ${r.first_name || '(no name)'} ${r.province || '(no prov)'} ${r.enriched_email}`);
    }
    if (args.dryRun) {
      console.log(`\nDRY RUN — no inserts. Run without --dry-run to enroll.`);
      return;
    }
    const sendAt = args.sendAt ? new Date(args.sendAt).toISOString() : new Date().toISOString();
    console.log(`\nEnrolling ${candidates.rows.length} recipients with next_send_at = ${sendAt}...`);
    let enrolled = 0, duplicates = 0, errored = 0;
    for (const r of candidates.rows) {
      try {
        const ab = r.id % 2 === 0 ? 'a' : 'b';
        const ins = await pool.query(
          `INSERT INTO v2_supply_enrollments
             (recipient_id, recipient_email, platform, sequence_name, current_step, next_send_at, ab_cohort)
           VALUES ($1, $2, $3, $4, 0, $5, $6)
           ON CONFLICT (recipient_id, platform, sequence_name) DO NOTHING
           RETURNING id`,
          [r.id, r.enriched_email, PLATFORM, SEQUENCE_NAME, sendAt, ab]
        );
        if (ins.rowCount === 0) duplicates++; else enrolled++;
      } catch (err) {
        console.error(`enroll ${r.id} failed: ${err.message}`);
        errored++;
      }
    }
    console.log(`\nEnrolled: ${enrolled}  Duplicates: ${duplicates}  Errors: ${errored}`);
    console.log(`First touch fires at: ${sendAt}`);
    console.log(`Sends ramp at ~50/5-min = 600/hour. Cohort will complete Touch 1 in ~${Math.ceil(enrolled / 600)} hour(s).`);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
