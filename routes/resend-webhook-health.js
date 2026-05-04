const express = require('express');
const { Pool } = require('pg');

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

const TABLE = process.env.WEBHOOK_EVENTS_TABLE || 'email_events';
const TS_COL = process.env.WEBHOOK_EVENTS_TS_COL || 'received_at';
const WARN_MIN = parseInt(process.env.WEBHOOK_HEALTH_WARN_MIN || '360', 10);
const FAIL_MIN = parseInt(process.env.WEBHOOK_HEALTH_FAIL_MIN || '1440', 10);

if (!IDENT_RE.test(TABLE)) {
  throw new Error(`[webhook-health] Invalid WEBHOOK_EVENTS_TABLE: "${TABLE}"`);
}
if (!IDENT_RE.test(TS_COL)) {
  throw new Error(`[webhook-health] Invalid WEBHOOK_EVENTS_TS_COL: "${TS_COL}"`);
}
if (!Number.isFinite(WARN_MIN) || WARN_MIN <= 0) {
  throw new Error(`[webhook-health] Invalid WEBHOOK_HEALTH_WARN_MIN: "${process.env.WEBHOOK_HEALTH_WARN_MIN}"`);
}
if (!Number.isFinite(FAIL_MIN) || FAIL_MIN <= WARN_MIN) {
  throw new Error(`[webhook-health] Invalid WEBHOOK_HEALTH_FAIL_MIN: "${process.env.WEBHOOK_HEALTH_FAIL_MIN}" (must be > WARN_MIN)`);
}

let _lazyPool;
function getPool(req) {
  if (req.app && req.app.locals && req.app.locals.pgPool) return req.app.locals.pgPool;
  try {
    const dbModule = require('../db');
    if (dbModule && dbModule.pool) return dbModule.pool;
  } catch (_) { /* no ../db module, fall through */ }
  if (!_lazyPool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('No DATABASE_URL available for health check pool');
    }
    _lazyPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 2,
    });
  }
  return _lazyPool;
}

const FRESHNESS_SQL = `
  SELECT
    MAX(${TS_COL}) AS last_event_at,
    COUNT(*) FILTER (WHERE ${TS_COL} >= NOW() - INTERVAL '1 hour')   AS events_1h,
    COUNT(*) FILTER (WHERE ${TS_COL} >= NOW() - INTERVAL '24 hours') AS events_24h,
    COUNT(*) FILTER (WHERE ${TS_COL} >= NOW() - INTERVAL '7 days')   AS events_7d
  FROM ${TABLE}
  WHERE ${TS_COL} IS NOT NULL
`;

const router = express.Router();

router.get('/', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');

  const strict = req.query.strict === 'true';
  const out = {
    status: 'unknown',
    table: TABLE,
    ts_col: TS_COL,
    secret_configured: Boolean(
      process.env.RESEND_WEBHOOK_SIGNING_SECRET || process.env.RESEND_WEBHOOK_SECRET
    ),
    thresholds: { warn_minutes: WARN_MIN, fail_minutes: FAIL_MIN },
    last_event_at: null,
    minutes_since_last_event: null,
    events_last_1h: null,
    events_last_24h: null,
    events_last_7d: null,
    checked_at: new Date().toISOString(),
  };

  try {
    const pool = getPool(req);
    const { rows } = await pool.query(FRESHNESS_SQL);
    const r = rows[0] || {};
    out.last_event_at = r.last_event_at ? new Date(r.last_event_at).toISOString() : null;
    out.events_last_1h = r.events_1h != null ? Number(r.events_1h) : 0;
    out.events_last_24h = r.events_24h != null ? Number(r.events_24h) : 0;
    out.events_last_7d = r.events_7d != null ? Number(r.events_7d) : 0;

    if (out.last_event_at) {
      const mins = Math.floor((Date.now() - new Date(out.last_event_at).getTime()) / 60000);
      out.minutes_since_last_event = mins;
      if (mins >= FAIL_MIN) out.status = 'fail';
      else if (mins >= WARN_MIN) out.status = 'warn';
      else out.status = 'healthy';
    } else {
      out.status = 'unknown';
    }
  } catch (err) {
    console.error('[webhook-health] query error:', err.message);
    out.status = 'unknown';
    out.error = err.message;
  }

  const httpStatus = (strict && out.status === 'fail') ? 503 : 200;
  res.status(httpStatus).json(out);
});

module.exports = router;
