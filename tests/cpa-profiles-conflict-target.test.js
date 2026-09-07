// cpa_profiles ON CONFLICT target guard (2026-09-07). ACC copy of the LAW test
// tests/lawyer-profiles-conflict-target.test.js (canadalawyers-backend PR #15),
// ledger row BP-013.
//
// Production cpa_profiles has unique indexes on id, cpa_id, email and
// referral_code ONLY (pg_indexes, verified read-only 2026-09-07). There is no
// unique index on user_id. An INSERT with ON CONFLICT (user_id) therefore
// raises "there is no unique or exclusion constraint matching the ON CONFLICT
// specification" on every call (EXPLAIN against production confirmed it).
// POST /api/claim/instant shipped with exactly that target inside a non-fatal
// catch, so an instant claimant could be marked claimed with no cpa_profiles
// row and be invisible to the dashboard and matching queries.
//
// This test reads every INSERT INTO cpa_profiles in the codebase and fails if
// any ON CONFLICT target is not one of the columns that is actually unique in
// production. If a new unique index is added in production via the boot
// migration, add its column to UNIQUE_COLUMNS in the same PR.

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const UNIQUE_COLUMNS = ['id', 'cpa_id', 'email', 'referral_code'];

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Each match is one INSERT INTO cpa_profiles statement up to the closing
// backtick of its template literal, so the ON CONFLICT clause (if any) is inside.
function cpaProfileInserts(src) {
  return src.match(/INSERT INTO cpa_profiles[\s\S]*?`/g) || [];
}

test('every INSERT INTO cpa_profiles uses an ON CONFLICT target that is unique in production', () => {
  const offenders = [];
  let inserts = 0;
  for (const file of listJsFiles(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const stmt of cpaProfileInserts(src)) {
      inserts++;
      const m = stmt.match(/ON CONFLICT\s*\(([^)]+)\)/i);
      if (!m) continue;
      const cols = m[1].split(',').map(c => c.trim().toLowerCase());
      const bad = cols.filter(c => !UNIQUE_COLUMNS.includes(c));
      if (bad.length) offenders.push(`${path.relative(ROOT, file)}: ON CONFLICT (${m[1].trim()})`);
    }
  }
  assert.ok(inserts >= 4, `expected at least 4 INSERT INTO cpa_profiles statements, found ${inserts}; the scanner regex is broken`);
  assert.deepStrictEqual(
    offenders,
    [],
    `ON CONFLICT target is not unique in production cpa_profiles.\n` +
    `  found:    ${offenders.join('; ')}\n` +
    `  expected: one of (${UNIQUE_COLUMNS.join(', ')})\n` +
    `  cause:    Postgres raises "no unique or exclusion constraint matching the ON CONFLICT specification" on every call, and the surrounding catch swallows it\n` +
    `  fix:      use ON CONFLICT (email), the target the other cpa_profiles upsert uses`
  );
});

test('POST /api/claim/instant inserts cpa_profiles with ON CONFLICT (email)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = src.indexOf("app.post('/api/claim/instant'");
  assert.ok(start > 0, "app.post('/api/claim/instant') not found in server.js");
  const end = src.indexOf('\napp.', start + 1);
  const handler = src.slice(start, end);
  const inserts = cpaProfileInserts(handler);
  assert.strictEqual(inserts.length, 1, `expected exactly one INSERT INTO cpa_profiles inside /api/claim/instant, found ${inserts.length}`);
  assert.match(inserts[0], /ON CONFLICT\s*\(email\)\s*DO NOTHING/i,
    'the instant-claim cpa_profiles insert must use ON CONFLICT (email) DO NOTHING; (user_id) has no unique index in production');
  assert.doesNotMatch(inserts[0], /ON CONFLICT\s*\(user_id\)/i);
});

// Production cpa_profiles.cpa_id is NOT NULL with no default (information_schema,
// 2026-09-07), the only such column on the table. An INSERT that omits it fails
// with a not-null violation into the same non-fatal catch, so the conflict-target
// fix above is not enough on its own. Every INSERT INTO cpa_profiles must name it.
test('every INSERT INTO cpa_profiles supplies cpa_id', () => {
  const offenders = [];
  for (const file of listJsFiles(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const stmt of cpaProfileInserts(src)) {
      const cols = (stmt.match(/INSERT INTO cpa_profiles\s*\(([^)]*)\)/i) || [])[1] || '';
      if (!cols.split(',').map(c => c.trim().toLowerCase()).includes('cpa_id')) {
        offenders.push(`${path.relative(ROOT, file)}: (${cols.replace(/\s+/g, ' ').trim().slice(0, 60)}...)`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `INSERT INTO cpa_profiles without cpa_id.\n` +
    `  found:    ${offenders.join('; ')}\n` +
    `  expected: cpa_id in the column list\n` +
    `  cause:    cpa_profiles.cpa_id is NOT NULL with no default in production; Postgres raises a not-null violation and the surrounding catch swallows it\n` +
    `  fix:      supply cpa_id, e.g. claim_<userId>_<Date.now()> as /api/claim/instant and the admin backfill do`
  );
});
