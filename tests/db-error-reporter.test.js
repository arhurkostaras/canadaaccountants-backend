// Pins the pool.query chokepoint (utils/db-error-reporter.js): every rejected query reports
// once to Sentry with code + sql prefix and is re-thrown unchanged; unique_violation is not
// reported; callback style still works; the wrapper is idempotent; and server.js installs it
// on the main pool right after construction.
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');
const { wrapPoolQuery, summarizeSql } = require('../utils/db-error-reporter');

function fakes() {
  const captured = [];
  const logged = [];
  const sentry = { captureException: (err, ctx) => captured.push({ err, ctx }) };
  const log = { error: (...a) => logged.push(a.join(' ')) };
  return { captured, logged, sentry, log };
}
function pgError(code, extra = {}) { return Object.assign(new Error('boom'), { code, ...extra }); }

test('a rejected query is reported once with code, constraint and sql prefix, then re-thrown', async () => {
  const { captured, logged, sentry, log } = fakes();
  const err = pgError('XX001', { constraint: 'idx_scraped_firm', table: 'scraped_cpas' });
  const pool = { query: async () => { throw err; } };
  wrapPoolQuery(pool, { sentry, log, label: 'pg' });
  await assert.rejects(() => pool.query('UPDATE   scraped_cpas\n SET static_page_at = NOW() WHERE id = ANY($1)', [[1]]), e => e === err);
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].err, err);
  assert.deepStrictEqual(captured[0].ctx.tags, { pg_code: 'XX001', db_source: 'pg' });
  assert.strictEqual(captured[0].ctx.extra.sql, 'UPDATE scraped_cpas SET static_page_at = NOW() WHERE id = ANY($1)');
  assert.strictEqual(captured[0].ctx.extra.constraint, 'idx_scraped_firm');
  assert.deepStrictEqual(captured[0].ctx.fingerprint, ['pg-query', 'XX001', 'idx_scraped_firm']);
  assert.strictEqual(logged.length, 1);
  assert.ok(logged[0].includes('XX001') && logged[0].includes('scraped_cpas'));
});

test('a successful query passes through untouched', async () => {
  const { captured, sentry, log } = fakes();
  const pool = { query: async (t, p) => ({ rows: [{ t, p }], rowCount: 1 }) };
  wrapPoolQuery(pool, { sentry, log });
  const r = await pool.query('SELECT 1', [2]);
  assert.deepStrictEqual(r.rows[0], { t: 'SELECT 1', p: [2] });
  assert.strictEqual(captured.length, 0);
});

test('unique_violation is control flow for the claim and referral routes and is not reported', async () => {
  const { captured, logged, sentry, log } = fakes();
  const pool = { query: async () => { throw pgError('23505'); } };
  wrapPoolQuery(pool, { sentry, log });
  await assert.rejects(() => pool.query('INSERT INTO referrals ...'));
  assert.strictEqual(captured.length, 0);
  assert.strictEqual(logged.length, 0);
});

test('callback-style pool.query is preserved and still reports', async () => {
  const { captured, sentry, log } = fakes();
  const err = pgError('42P01');
  const pool = { query: (text, params, cb) => { if (typeof params === 'function') { cb = params; params = undefined; } setImmediate(() => cb(err)); } };
  wrapPoolQuery(pool, { sentry, log });
  await new Promise(resolve => pool.query('SELECT * FROM missing', (e) => { assert.strictEqual(e, err); resolve(); }));
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].ctx.tags.pg_code, '42P01');
});

test('a QueryConfig object is summarized from its text; parameters never appear', async () => {
  const { captured, sentry, log } = fakes();
  const pool = { query: async () => { throw pgError('22P02'); } };
  wrapPoolQuery(pool, { sentry, log });
  await assert.rejects(() => pool.query({ text: 'SELECT $1::int', values: ['secret-value'] }));
  assert.strictEqual(captured[0].ctx.extra.sql, 'SELECT $1::int');
  assert.ok(!JSON.stringify(captured[0].ctx).includes('secret-value'));
  assert.strictEqual(summarizeSql('a'.repeat(500)).length, 160);
});

test('wrapping twice installs once, and a missing or broken Sentry never breaks the caller', async () => {
  const { sentry, log } = fakes();
  const pool = { query: async () => { throw pgError('XX000'); } };
  wrapPoolQuery(pool, { sentry, log });
  const once = pool.query;
  wrapPoolQuery(pool, { sentry, log });
  assert.strictEqual(pool.query, once);
  const noSentry = { query: async () => { throw pgError('XX000'); } };
  wrapPoolQuery(noSentry, { sentry: null, log });
  await assert.rejects(() => noSentry.query('SELECT 1'), e => e.code === 'XX000');
  const broken = { query: async () => { throw pgError('XX000'); } };
  wrapPoolQuery(broken, { sentry: { captureException: () => { throw new Error('sentry down'); } }, log });
  await assert.rejects(() => broken.query('SELECT 1'), e => e.code === 'XX000');
});

test('server.js and services/ai.js install the chokepoint on their pools', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const poolAt = src.indexOf('const pool = new Pool({');
  const wrapAt = src.indexOf('wrapPoolQuery(pool');
  assert.ok(poolAt > 0 && wrapAt > poolAt, 'server.js must wrap the main pool after constructing it');
  assert.ok(wrapAt - poolAt < 1500, 'the wrap must sit right after pool construction, before any query runs');
  const ai = fs.readFileSync(path.join(__dirname, '..', 'services', 'ai.js'), 'utf8');
  assert.ok(ai.includes('wrapPoolQuery('), 'services/ai.js must wrap its dedicated pool');
});
