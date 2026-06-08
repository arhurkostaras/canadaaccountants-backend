#!/usr/bin/env node
/**
 * webhook-signal-contract.test.js  —  BP-WEBHOOK-HEALTH-001
 *
 * Enforces the invariant both INV bugs violated:
 *   (1) a SEND must NOT advance the health endpoint's event signal  (conflated-source bug)
 *   (2) a webhook EVENT must advance it                             (unwritten-column bug)
 *
 * Strategy: pick one existing row, mutate it inside a transaction, assert, ROLLBACK.
 * Nothing persists — safe against the live DB (brief row lock only).
 *
 * Run per platform so Railway injects the matching DATABASE_URL:
 *   railway run --service canadaaccountants-backend   -- node webhook-signal-contract.test.js ACC
 *   railway run --service canadalawyers-backend        -- node webhook-signal-contract.test.js LAW
 *   railway run --service canadabusinessexits-backend  -- node webhook-signal-contract.test.js CBE
 *   railway run --service canadainvesting-backend      -- node webhook-signal-contract.test.js INV
 *
 * Exit 0 = pass, 1 = contract violated/error, 2 = setup or skip.
 *
 * IMPORTANT: each platform's lastEventSql MUST stay identical to the query wired
 * into that backend's server.js. If you change one, change both.
 */
const { Pool } = require('pg');

const PLATFORMS = {
  ACC: {
    lastEventSql: `SELECT GREATEST(MAX(delivered_at),MAX(opened_at),MAX(clicked_at),MAX(bounced_at),MAX(complained_at)) AS ts FROM outreach_emails`,
    pickId:    `SELECT id FROM outreach_emails ORDER BY id DESC LIMIT 1`,
    markSent:  `UPDATE outreach_emails SET sent_at = NOW() WHERE id = $1`,       // send-side only
    markEvent: `UPDATE outreach_emails SET delivered_at = NOW() WHERE id = $1`,  // webhook-only event col
  },
  CBE: {
    lastEventSql: `SELECT GREATEST(MAX(delivered_at),MAX(opened_at),MAX(clicked_at),MAX(bounced_at)) AS ts FROM outreach_emails`,
    pickId:    `SELECT id FROM outreach_emails ORDER BY id DESC LIMIT 1`,
    markSent:  `UPDATE outreach_emails SET sent_at = NOW() WHERE id = $1`,
    markEvent: `UPDATE outreach_emails SET delivered_at = NOW() WHERE id = $1`,
  },
  INV: {
    lastEventSql: `SELECT MAX(last_event_at) AS ts FROM outreach_campaigns`,
    pickId:    `SELECT id FROM outreach_campaigns ORDER BY id LIMIT 1`,
    // send path: bumps the counter + updated_at — must NOT move last_event_at
    markSent:  `UPDATE outreach_campaigns SET total_sent = COALESCE(total_sent,0) + 1, updated_at = NOW() WHERE id = $1`,
    // webhook event: stamps the webhook-only column
    markEvent: `UPDATE outreach_campaigns SET last_event_at = NOW() WHERE id = $1`,
  },
};
PLATFORMS.LAW = { ...PLATFORMS.ACC }; // identical schema to ACC

const ms = (v) => (v == null ? null : new Date(v).getTime());

async function maxEvent(client, cfg) {
  const { rows } = await client.query(cfg.lastEventSql);
  return ms(rows[0] && rows[0].ts);
}

async function main() {
  const name = (process.argv[2] || '').toUpperCase();
  const cfg = PLATFORMS[name];
  if (!cfg) {
    console.error('usage: node webhook-signal-contract.test.js <ACC|LAW|CBE|INV>');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — run via `railway run --service <svc> --`');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let code = 0;
  try {
    const pick = await client.query(cfg.pickId);
    if (!pick.rows.length) {
      console.error(`${name}: SKIP — no rows available to probe`);
      process.exit(2);
    }
    const id = pick.rows[0].id;

    await client.query('BEGIN');
    const baseline = await maxEvent(client, cfg);

    // (1) SEND must not advance the event signal.
    await client.query(cfg.markSent, [id]);
    const afterSend = await maxEvent(client, cfg);
    const sendOk = afterSend === baseline;

    // (2) EVENT must advance the event signal.
    await client.query(cfg.markEvent, [id]);
    const afterEvent = await maxEvent(client, cfg);
    const eventOk = afterEvent !== null && (baseline === null || afterEvent > baseline);

    await client.query('ROLLBACK'); // nothing persists

    if (sendOk && eventOk) {
      console.log(`${name}: PASS — send inert, event advances (signal is webhook-only)`);
    } else {
      code = 1;
      if (!sendOk) {
        console.error(`${name}: FAIL — SEND advanced the event signal (conflated source). baseline=${baseline} afterSend=${afterSend}`);
      }
      if (!eventOk) {
        console.error(`${name}: FAIL — webhook EVENT did not advance the event signal (unwritten/missing column). baseline=${baseline} afterEvent=${afterEvent}`);
      }
    }
  } catch (err) {
    code = 1;
    console.error(`${name}: ERROR — ${err.message}`);
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(code);
}

main();
