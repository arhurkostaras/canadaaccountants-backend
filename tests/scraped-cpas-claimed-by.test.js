// scraped_cpas claim-stamp guard (2026-09-07). ACC copy of the LAW test
// tests/scraped-lawyers-claimed-at.test.js (canadalawyers-backend PR #17) and
// the INV copy (canadainvesting-backend PR #13), ledger row BP-012.
//
// On ACC this is regression insurance, not a fix: the only claim writer is
// POST /api/claim/instant and it already sets claimed_by. LAW and INV each
// grew a second writer (the Stripe webhook's application-payment branch) that
// did not; on LAW it also named scraped_lawyers.claimed_at, a column production
// does not have, and the surrounding catch swallowed the error. Production
// scraped_cpas has no claimed_at either (the only claimed_at is on
// signal_emails); its claim columns are claim_status, claimed_by, claim_token,
// claim_requested_at.
//
// Two assertions, scanned over every .js file outside node_modules and tests:
//   1. No SQL statement that touches scraped_cpas references claimed_at.
//   2. Every statement that writes claim_status = 'claimed' also writes
//      claimed_by, so each claim path produces the state /api/claim/instant
//      produces (the state-transition rule: grep every writer, check each
//      carries the same side effect). The writer count is pinned so a new
//      claim path has to opt in here.

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

// SQL in this codebase lives in template literals and quoted strings. Each
// match is one literal, so a column name and the table it belongs to are
// inside the same match.
function sqlLiterals(src) {
  return src.match(/`[^`]*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) || [];
}

function lineOf(src, needle) {
  const idx = src.indexOf(needle);
  return idx < 0 ? '?' : src.slice(0, idx).split('\n').length;
}

test('no SQL that touches scraped_cpas references claimed_at', () => {
  const offenders = [];
  let scanned = 0;
  for (const file of listJsFiles(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const lit of sqlLiterals(src)) {
      if (!/\bscraped_cpas\b/.test(lit)) continue;
      scanned++;
      if (/\bclaimed_at\b/.test(lit)) {
        offenders.push(`${path.relative(ROOT, file)}:${lineOf(src, lit)}`);
      }
    }
  }
  // Sanity floor for the scanner, not a scope pin: server.js alone carries 49
  // scraped_cpas literals (2026-09-07), the rest come from services/, tools/,
  // utils/ and scripts/. 40 trips on a broken regex without tripping on a
  // narrower scan.
  assert.ok(scanned >= 40, `expected at least 40 SQL literals naming scraped_cpas, found ${scanned}; the scanner regex is broken`);
  assert.deepStrictEqual(
    offenders,
    [],
    `scraped_cpas.claimed_at does not exist in production.\n` +
    `  found:    ${offenders.join('; ')}\n` +
    `  expected: no claimed_at in any statement that touches scraped_cpas\n` +
    `  cause:    Postgres raises "column claimed_at does not exist" and the surrounding catch swallows it, so the claim never lands\n` +
    `  fix:      the claim columns are claim_status and claimed_by; use claimed_by = <users.id> (see /api/claim/instant)`
  );
});

test("every scraped_cpas write of claim_status = 'claimed' also sets claimed_by", () => {
  const offenders = [];
  let writers = 0;
  for (const file of listJsFiles(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const lit of sqlLiterals(src)) {
      if (!/UPDATE\s+scraped_cpas\s+SET[\s\S]*claim_status\s*=\s*'claimed'/i.test(lit)) continue;
      writers++;
      if (!/\bclaimed_by\s*=\s*\$\d+/.test(lit)) {
        offenders.push(`${path.relative(ROOT, file)}:${lineOf(src, lit)}`);
      }
    }
  }
  assert.strictEqual(writers, 1, `expected exactly 1 claim_status = 'claimed' writer (/api/claim/instant), found ${writers}; if a new claim path was added (a Stripe webhook claim stamp, a lead magic link), it must set claimed_by and this count moves up`);
  assert.deepStrictEqual(
    offenders,
    [],
    `a claim path writes claim_status = 'claimed' without claimed_by.\n` +
    `  found:    ${offenders.join('; ')}\n` +
    `  expected: claimed_by = $n bound to the users.id of the claimant in the same UPDATE\n` +
    `  cause:    the dashboard joins and the admin backfill key on claimed_by, so a claim without it is invisible to them\n` +
    `  fix:      resolve the users row first (INSERT ... ON CONFLICT (email) ... RETURNING id), then write claimed_by in the same UPDATE`
  );
});
