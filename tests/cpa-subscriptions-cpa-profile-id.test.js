// cpa_subscriptions.cpa_profile_id type guard (2026-09-07). ACC copy of the LAW test
// tests/lawyer-subscriptions-cpa-profile-id.test.js (canadalawyers-backend PR #19).
//
// Production cpa_subscriptions.cpa_profile_id is VARCHAR(255) (information_schema,
// verified 2026-09-07; 2 canceled rows, both NULL), while cpa_profiles.id is INTEGER
// (SERIAL). Any SQL that compares the column to cp.id, to a bare id from
// cpa_profiles, or to an integer literal without a cast raises
//   operator does not exist: character varying = integer
// at runtime. GET /api/cpa/seo-score, GET /api/stripe/subscription-status,
// POST /api/stripe/create-portal-session and GET /api/dashboard/matches shipped
// with exactly that join. Parameter comparisons ($1) are fine: an untyped parameter
// adopts the column's type.
//
// The convention is a text compare on both sides (`cs.cpa_profile_id::text =
// cp.id::text`, `cpa_profile_id::text IN (SELECT id::text ...)`) so the query holds
// before and after the flag-gated retype migration in server.js
// (CPA_SUBS_CPA_PROFILE_ID_RETYPE). Once the column is INTEGER in production and
// the migration block is removed, the casts can go and this test's rule flips to
// "no cast needed".
//
// Note: `cpa_profile_id` is also a column on matches and client_requests, where it
// is INTEGER and compared to integer params; those never appear beside cp.id or a
// literal, so the patterns below do not fire on them.

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// `cpa_profile_id` or `<alias>.cpa_profile_id`, NOT followed by a cast.
const COL = String.raw`\b(?:\w+\.)?cpa_profile_id\b(?!\s*::)`;
// `id`, `cp.id`, `cpa_profiles.id`, NOT followed by a cast.
const PROFILE_ID = String.raw`\b(?:\w+\.)?id\b(?!\s*::)`;
const OP = String.raw`\s*(?:=|<>|!=)\s*`;

// Each entry: [name, regex, what the failing query looks like, the fix].
const UNCAST_COMPARISONS = [
  ['column = profile id',
    new RegExp(COL + OP + PROFILE_ID, 'g'),
    'cs.cpa_profile_id = cp.id',
    'cs.cpa_profile_id::text = cp.id::text'],
  ['profile id = column',
    new RegExp(PROFILE_ID + OP + String.raw`(?:\w+\.)?cpa_profile_id\b(?!\s*::)`, 'g'),
    'cp.id = cs.cpa_profile_id',
    'cs.cpa_profile_id::text = cp.id::text'],
  ['column = integer literal',
    new RegExp(COL + OP + String.raw`\d`, 'g'),
    'cpa_profile_id = 10',
    "cpa_profile_id = '10' (or bind it as $n)"],
  ['integer literal = column',
    new RegExp(String.raw`\b\d+` + OP + String.raw`(?:\w+\.)?cpa_profile_id\b(?!\s*::)`, 'g'),
    '10 = cpa_profile_id',
    "cpa_profile_id = '10' (or bind it as $n)"],
  ['column IN (integer literals)',
    new RegExp(COL + String.raw`\s+(?:NOT\s+)?IN\s*\(\s*\d`, 'g'),
    'cpa_profile_id IN (1, 2)',
    "cpa_profile_id IN ('1', '2') (or bind them as ANY($n))"],
  ['column IN (SELECT id FROM cpa_profiles ...)',
    new RegExp(COL + String.raw`\s+(?:NOT\s+)?IN\s*\(\s*SELECT\s+` + PROFILE_ID + String.raw`\s+FROM\s+cpa_profiles\b`, 'gi'),
    'cpa_profile_id IN (SELECT id FROM cpa_profiles ...)',
    'cpa_profile_id::text IN (SELECT id::text FROM cpa_profiles ...)'],
];

// Cast comparisons in the agreed shape; counted to prove the scanner sees the real sites.
const CAST_COMPARISON = /cpa_profile_id::text\s*(?:=\s*(?:\w+\.)?id::text|IN\s*\(\s*SELECT\s+(?:\w+\.)?id::text\s+FROM\s+cpa_profiles)/gi;

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function findUncast(src) {
  const hits = [];
  for (const [name, re, shape, fix] of UNCAST_COMPARISONS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      hits.push({ name, shape, fix, line: lineOf(src, m.index), text: m[0].replace(/\s+/g, ' ') });
    }
  }
  return hits;
}

test('detector catches the comparison shapes that failed in production', () => {
  const bad = [
    'JOIN cpa_profiles cp ON cs.cpa_profile_id = cp.id WHERE cp.user_id = $1',
    'LEFT JOIN cpa_subscriptions cs ON cp.id = cs.cpa_profile_id',
    'DELETE FROM cpa_subscriptions WHERE cpa_profile_id IN (SELECT id FROM cpa_profiles WHERE user_id = ANY($1))',
    'DELETE FROM cpa_subscriptions WHERE cpa_profile_id = 10',
    'WHERE 10 = cs.cpa_profile_id',
    'WHERE cpa_profile_id IN (1, 2)',
    'ON cpa_profiles.id = cpa_subscriptions.cpa_profile_id',
  ];
  for (const sql of bad) {
    assert.ok(findUncast(sql).length > 0, `detector missed an uncast comparison: ${sql}`);
  }
  const good = [
    'JOIN cpa_profiles cp ON cs.cpa_profile_id::text = cp.id::text',
    'JOIN cpa_profiles cp ON cp.id::text = cs.cpa_profile_id',
    'JOIN cpa_profiles cp ON cs.cpa_profile_id::integer = cp.id',
    'WHERE cpa_profile_id::text IN (SELECT id::text FROM cpa_profiles WHERE user_id = $1)',
    'WHERE cpa_profile_id = $1 AND status = $2',
    "WHERE cpa_profile_id = '10'",
    'INSERT INTO matches (cpa_profile_id, client_profile_id, overall_score) VALUES ($1, $2, $3)',
    'SELECT u.*, cp.id as cpa_profile_id, cp.first_name FROM users u',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx ON cpa_subscriptions (cpa_profile_id)',
  ];
  for (const sql of good) {
    assert.deepStrictEqual(findUncast(sql), [], `detector false positive on: ${sql}`);
  }
});

test('no query compares cpa_subscriptions.cpa_profile_id to a profile id or integer without a cast', () => {
  const offenders = [];
  let castSites = 0;
  for (const file of listJsFiles(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('cpa_profile_id')) continue;
    const rel = path.relative(ROOT, file);
    for (const hit of findUncast(src)) offenders.push({ rel, ...hit });
    castSites += (src.match(CAST_COMPARISON) || []).length;
  }

  assert.deepStrictEqual(
    offenders.map(o => `${o.rel}:${o.line} [${o.name}] "${o.text}"\n    Postgres raises: operator does not exist: character varying = integer` +
      `\n    (production cpa_subscriptions.cpa_profile_id is VARCHAR(255); cpa_profiles.id is INTEGER)` +
      `\n    Expected shape: ${o.fix}`),
    [],
    'Uncast comparison(s) against cpa_subscriptions.cpa_profile_id:'
  );

  // server.js: seo-score, subscription-status, create-portal-session, dashboard/matches.
  assert.ok(castSites >= 4,
    `expected at least 4 cast comparison sites (found ${castSites}); if sites were removed on purpose, lower this floor in the same PR`);
});

// Production cpa_subscriptions columns (information_schema, 2026-09-07): id, email,
// cpa_profile_id, stripe_customer_id, stripe_subscription_id, tier, billing_interval,
// status, current_period_start, current_period_end, created_at, updated_at. The plan
// column is `tier`. schema.sql declares `plan_type`, which production never had; five
// queries named it (webhook upsert, seo-score, pipeline MRR, dashboard/matches) and
// each raised "column cs.plan_type does not exist" (found 2026-09-07 by the live
// end-to-end check after the cast fix landed). Same class as BP-012.
function cpaSubscriptionStatements(src) {
  // Each match is one template literal that mentions cpa_subscriptions.
  return (src.match(/`[^`]*\bcpa_subscriptions\b[^`]*`/g) || []);
}

test('no SQL touching cpa_subscriptions names plan_type (production column is tier)', () => {
  const offenders = [];
  for (const file of listJsFiles(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('cpa_subscriptions')) continue;
    const rel = path.relative(ROOT, file);
    for (const stmt of cpaSubscriptionStatements(src)) {
      if (/\bplan_type\b/.test(stmt)) {
        offenders.push(`${rel}:${lineOf(src, src.indexOf(stmt))} "${stmt.replace(/\s+/g, ' ').slice(0, 120)}"` +
          `\n    Postgres raises: column plan_type does not exist (production cpa_subscriptions has tier, not plan_type)` +
          `\n    Expected: tier`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], 'cpa_subscriptions statement(s) naming plan_type:');
});
