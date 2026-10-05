// One chokepoint for database failures (OPERATIONS.md 2026-10-05, index-corruption incident).
//
// Five corrupt indexes failed writes on the production instance for an unknown period and
// Sentry recorded none of it: the backend has ~290 console.error sites and a dozen swallowed
// catches, so a failed UPDATE was logged to the Railway stream (or nowhere) and never reached
// Sentry. Rather than touch every call site, wrap pool.query once. Every rejected query is
// reported to Sentry with the Postgres error code, the constraint/table when the driver
// supplies them, and a whitespace-collapsed prefix of the SQL text (parameters are never
// included, so no row data leaks), then re-thrown unchanged so callers behave exactly as
// before. Callback-style pool.query(text, cb) is preserved.
//
// Not reported: 23505 unique_violation, which routes use as control flow (409 "already
// claimed", "already referred"). Add codes to ignoredCodes if another one proves to be flow.

const DEFAULT_IGNORED = new Set(['23505']);

function summarizeSql(text, max = 160) {
  const raw = (text && typeof text === 'object') ? text.text : text;
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function reportQueryError(err, text, { sentry, label, log } = {}) {
  const sql = summarizeSql(text);
  const code = err && err.code ? String(err.code) : 'none';
  (log || console).error(`[${label || 'pg'}] query failed: ${code} ${err && err.message} :: ${sql}`);
  if (!sentry || typeof sentry.captureException !== 'function') return;
  try {
    sentry.captureException(err, {
      tags: { pg_code: code, db_source: label || 'pg' },
      extra: { sql, detail: err.detail, table: err.table, constraint: err.constraint, schema: err.schema },
      // Group by error class + the object it names, so one corrupt index is one issue
      // however many routes trip over it.
      fingerprint: ['pg-query', code, err.constraint || err.table || sql.slice(0, 60)],
    });
  } catch (_) { /* reporting must never break the caller */ }
}

function wrapPoolQuery(pool, { sentry = null, label = 'pg', ignoredCodes = DEFAULT_IGNORED, log = console } = {}) {
  if (!pool || typeof pool.query !== 'function' || pool.query.__dbErrorReporter) return pool;
  const original = pool.query.bind(pool);
  const shouldReport = err => err && !ignoredCodes.has(String(err.code));
  const report = (err, text) => { if (shouldReport(err)) reportQueryError(err, text, { sentry, label, log }); };

  function query(text, ...rest) {
    const last = rest[rest.length - 1];
    if (typeof last === 'function') {
      const cb = last;
      return original(text, ...rest.slice(0, -1), (err, res) => { if (err) report(err, text); cb(err, res); });
    }
    const p = original(text, ...rest);
    return p.then(r => r, err => { report(err, text); throw err; });
  }
  query.__dbErrorReporter = true;
  pool.query = query;
  return pool;
}

module.exports = { wrapPoolQuery, reportQueryError, summarizeSql, DEFAULT_IGNORED };
