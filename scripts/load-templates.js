#!/usr/bin/env node
// Bulk-loads supply_v2 email templates into email_template table.
//
// Usage:
//   DATABASE_URL=... node scripts/load-templates.js path/to/templates.json
//
// JSON format: array of objects with these fields per row:
//   {
//     "platform": "law",                    // must match the backend's platform
//     "sequence": "supply_v2_7touch",
//     "touch_number": 1,
//     "variant": "default",                  // or "lite", "a", "b"
//     "subject_a": "...",
//     "subject_b": "...",                    // optional, for Touch 1 + Touch 6
//     "body_text": "...",
//     "body_html": "...",
//     "is_lite": false
//   }
//
// Idempotent: ON CONFLICT (platform, sequence, touch_number, variant) DO UPDATE.
// Re-running with the same JSON updates rows in place — safe to revise drafts
// and re-run.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PLATFORM_THIS_BACKEND = 'acc';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/load-templates.js path/to/templates.json');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL env var required');
    process.exit(2);
  }
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  let rows;
  try { rows = JSON.parse(raw); } catch (err) {
    console.error(`failed to parse ${file}:`, err.message);
    process.exit(2);
  }
  if (!Array.isArray(rows)) {
    console.error('expected JSON array at top level');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let inserted = 0, updated = 0, skipped = 0;
  try {
    for (const r of rows) {
      if (r.platform && r.platform !== PLATFORM_THIS_BACKEND) {
        console.warn(`skipping row for platform ${r.platform} (this backend is ${PLATFORM_THIS_BACKEND})`);
        skipped++;
        continue;
      }
      if (!r.sequence || !Number.isInteger(r.touch_number)) {
        console.warn('skipping malformed row:', JSON.stringify(r).slice(0, 80));
        skipped++;
        continue;
      }
      const result = await pool.query(`
        INSERT INTO email_template
          (platform, sequence, touch_number, variant, subject_a, subject_b, body_text, body_html, is_lite, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (platform, sequence, touch_number, variant)
        DO UPDATE SET
          subject_a = EXCLUDED.subject_a,
          subject_b = EXCLUDED.subject_b,
          body_text = EXCLUDED.body_text,
          body_html = EXCLUDED.body_html,
          is_lite   = EXCLUDED.is_lite,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted`,
        [PLATFORM_THIS_BACKEND, r.sequence, r.touch_number, r.variant || 'default',
         r.subject_a || null, r.subject_b || null,
         r.body_text || null, r.body_html || null, !!r.is_lite]);
      if (result.rows[0]?.inserted) inserted++; else updated++;
    }
    console.log(`Loaded ${rows.length} templates: ${inserted} new, ${updated} updated, ${skipped} skipped (wrong platform or malformed)`);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
