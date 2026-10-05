// House fallback resolver (2026-10-05). Both matchers append the house CPA (Arthur,
// cpa_profiles.id=3) when real matches < 3, but they looked it up only by
// fallback_priority = true AND is_active = true. Production had no row passing that
// filter, so the append never fired (no "house fallback appended" line in the
// deployment logs) and Renata Medeiros (client_profile_id 23) got a single weak match.
// findHouseFallbackCpa now falls back to HOUSE_FALLBACK_CPA_ID. This test extracts the
// helper from server.js and runs it against a fake pool, and checks both call sites use it.

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadHelper(rowsFor) {
  const m = SRC.match(/async function findHouseFallbackCpa\(tag\) \{[\s\S]*?\n\}\n/);
  assert.ok(m, 'findHouseFallbackCpa not found in server.js');
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: rowsFor(sql, params) }; } };
  const fn = new Function('pool', 'process', 'console', `${m[0]}; return findHouseFallbackCpa;`)(
    pool, { env: {} }, { warn() {}, error() {}, log() {} });
  return { fn, queries };
}

test('returns the flagged active row when one exists', async () => {
  const { fn, queries } = loadHelper(sql => (sql.includes('fallback_priority') ? [{ id: 9 }] : []));
  assert.deepStrictEqual(await fn('t'), { id: 9 });
  assert.strictEqual(queries.length, 1);
});

test('falls back to cpa_profiles.id=3 when no row is flagged', async () => {
  const { fn, queries } = loadHelper((sql, params) => (params && params[0] === 3 ? [{ id: 3, is_active: false }] : []));
  assert.deepStrictEqual(await fn('t'), { id: 3, is_active: false });
  assert.strictEqual(queries[1].params[0], 3);
});

test('returns null when neither lookup finds a row', async () => {
  const { fn } = loadHelper(() => []);
  assert.strictEqual(await fn('t'), null);
});

test('both matchers resolve the fallback through the helper', () => {
  assert.strictEqual((SRC.match(/await findHouseFallbackCpa\('(CPAMatch|FrictionMatch)'\)/g) || []).length, 2);
  assert.ok(!/fb = await pool\.query\("SELECT \* FROM cpa_profiles WHERE COALESCE\(fallback_priority/.test(SRC),
    'an inline fallback query bypasses findHouseFallbackCpa');
});
