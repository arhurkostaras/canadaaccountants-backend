// scripts/referral-code-backfill.js
// One-time backfill of referral_code on the platform's professional table
// (Build Spec v1.2 section 3). Dry-run by default; --execute to write.
//
//   DATABASE_URL=... PLATFORM_ID=ACC node scripts/referral-code-backfill.js            (dry run)
//   DATABASE_URL=... PLATFORM_ID=ACC node scripts/referral-code-backfill.js --execute
//
// Design:
//   - Batches of at most 1,000 rows per UPDATE statement (bulk-op rule; matters
//     on platforms with larger pro tables than ACC's).
//   - Codes: PLATFORM_ID + '-' + 6 chars of a 32-char alphabet with no I/L/O/U
//     (same generator as modules/referrals/service.js).
//   - Collision handling, two layers:
//       1. In-memory: codes deduped within the run; a batch retries generation
//          until all its codes are distinct from each other and from any code
//          seen this run.
//       2. Database: the UNIQUE index idx_<table>_referral_code (created in the
//          Step 2 migration) makes a colliding write impossible; on a unique
//          violation the batch regenerates and retries (up to 5 times) rather
//          than failing the run.
//   - Only rows WHERE referral_code IS NULL are touched; re-running is safe.
//   - Refuses unknown PLATFORM_ID; table name resolves through the module config.

'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const EXECUTE = process.argv.includes('--execute');
const BATCH = 1000;

const PLATFORM_ID = process.env.PLATFORM_ID || 'ACC';
process.env.PLATFORM_ID = PLATFORM_ID;
const config = require('../modules/referrals/config');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function code() {
  const b = crypto.randomBytes(6);
  let c = '';
  for (let i = 0; i < 6; i++) c += ALPHABET[b[i] % ALPHABET.length];
  return `${config.PLATFORM_ID}-${c}`;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('FAIL: DATABASE_URL required');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const table = config.PRO_TABLE;
  if (/TODO/.test(table)) {
    console.error(`FAIL: PRO_TABLE for ${config.PLATFORM_ID} is unverified (${table}) - verify in-repo first`);
    process.exit(1);
  }

  const counts = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE referral_code IS NULL)::int AS pending
       FROM ${table}`
  );
  const { total, pending } = counts.rows[0];
  console.log(`[backfill] platform=${config.PLATFORM_ID} table=${table} total=${total} pending=${pending} mode=${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);

  if (!EXECUTE) {
    const sample = await pool.query(
      `SELECT id FROM ${table} WHERE referral_code IS NULL ORDER BY id LIMIT 5`
    );
    console.log('[backfill] first rows to update (id -> sample code):');
    for (const row of sample.rows) console.log(`  ${row.id} -> ${code()}`);
    console.log(`[backfill] would run ${Math.ceil(pending / BATCH)} batched UPDATE statement(s), <= ${BATCH} rows each.`);
    console.log('[backfill] dry run only - nothing written. Re-run with --execute.');
    await pool.end();
    return;
  }

  const seen = new Set();
  let updated = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id FROM ${table} WHERE referral_code IS NULL ORDER BY id LIMIT ${BATCH}`
    );
    if (rows.length === 0) break;

    let attempt = 0;
    for (;;) {
      attempt++;
      if (attempt > 5) throw new Error(`batch failed 5 collision retries (ids ${rows[0].id}..)`);
      // Generate a distinct code per row (unique within the run).
      const pairs = rows.map((r) => {
        let c;
        do { c = code(); } while (seen.has(c));
        seen.add(c);
        return [r.id, c];
      });
      const values = pairs.map((_, i) => `($${i * 2 + 1}::int, $${i * 2 + 2}::text)`).join(',');
      const params = pairs.flat();
      try {
        const res = await pool.query(
          `UPDATE ${table} AS t SET referral_code = v.code
             FROM (VALUES ${values}) AS v(id, code)
            WHERE t.id = v.id AND t.referral_code IS NULL`,
          params
        );
        updated += res.rowCount;
        console.log(`[backfill] batch ok: ${res.rowCount} rows (total ${updated})`);
        break;
      } catch (err) {
        if (err.code === '23505') {
          // Unique-index collision with a pre-existing code: regenerate and retry.
          console.error(`[backfill] unique collision on attempt ${attempt}, regenerating batch: ${err.detail || err.message}`);
          pairs.forEach(([, c]) => seen.delete(c));
          continue;
        }
        throw err;
      }
    }
  }

  const after = await pool.query(
    `SELECT count(*) FILTER (WHERE referral_code IS NULL)::int AS still_null,
            count(DISTINCT referral_code)::int AS distinct_codes,
            count(*) FILTER (WHERE referral_code IS NOT NULL)::int AS coded
       FROM ${table}`
  );
  console.log(`[backfill] done: updated=${updated} still_null=${after.rows[0].still_null} coded=${after.rows[0].coded} distinct=${after.rows[0].distinct_codes}`);
  if (after.rows[0].coded !== after.rows[0].distinct_codes) {
    console.error('[backfill] WARNING: coded != distinct - investigate immediately');
    process.exit(1);
  }
  await pool.end();
}

main().catch((err) => {
  console.error('[backfill] FAILED:', err.message);
  process.exit(1);
});
