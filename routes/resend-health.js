// routes/resend-health.js
// -----------------------------------------------------------------------------
// One grading engine, per-platform signal adapters.
//
// Each backend passes the two queries that expose ITS real signals:
//   - lastSendSql  -> most recent outbound send  (column `ts`)
//   - lastEventSql -> most recent webhook event  (column `ts`)
//
// ACC/LAW/CBE expose timestamped event rows; INV exposes a status enum +
// campaign counters. Both feed the SAME grader, so the two models can no longer
// diverge into "unknown-forever, monitor-blind".
//
// Pass states (match the existing harness allow-list): healthy | warn | unknown
// Alarm state: fail
//
// Guardrail: sends older than the Svix retry window with ZERO events ever
// recorded returns `fail` (loud), not `unknown` (silent). That is precisely the
// INV failure class — a health check pointed at a column the handler never
// writes can no longer pass silently.
//
// The security gate (unsigned POST -> 401) lives in the POST handler and is
// untouched here. It remains the only true CRITICAL. Test it against the
// backend ORIGIN, not the CDN-fronted apex (apex returns 405 from Varnish).
// -----------------------------------------------------------------------------

const express = require('express');

const SEND_GRACE_MIN = 90;        // normal send -> first webhook lag
const SVIX_RETRY_MIN = 24 * 60;   // Svix retries ~24h before giving up
const IDLE_AFTER_MIN = 36 * 60;   // no sends in this window => idle, not broken

/**
 * @param {import('pg').Pool} pool  singleton pool — never per-request
 * @param {{ lastSendSql: string, lastEventSql: string }} cfg
 *        Each query must return a single row with a column named `ts`.
 */
function buildResendHealth(pool, cfg) {
  const router = express.Router();

  router.get('/api/webhooks/resend/health', async (_req, res) => {
    try {
      const [sendRes, eventRes] = await Promise.all([
        pool.query(cfg.lastSendSql),
        pool.query(cfg.lastEventSql),
      ]);

      const now = Date.now();
      const lastSend  = sendRes.rows[0]?.ts  ? new Date(sendRes.rows[0].ts).getTime()  : null;
      const lastEvent = eventRes.rows[0]?.ts ? new Date(eventRes.rows[0].ts).getTime() : null;
      const minsSinceSend  = lastSend  ? Math.round((now - lastSend)  / 60000) : null;
      const minsSinceEvent = lastEvent ? Math.round((now - lastEvent) / 60000) : null;

      let status, reason;

      if (!lastSend) {
        status = 'unknown';
        reason = 'no send activity recorded — liveness indeterminate, not broken';

      } else if (lastEvent === null) {
        // Sends exist but the configured event signal is EMPTY.
        if (minsSinceSend > SVIX_RETRY_MIN) {
          // Sends are old enough that events should have arrived. This is the
          // INV class: the query is reading a column nothing writes. Go loud.
          status = 'fail';
          reason = `sends ${minsSinceSend}m old but zero events ever recorded — health check is reading the wrong signal`;
        } else {
          status = 'warn';
          reason = `recent sends, no events yet — within Svix retry window`;
        }

      } else if (minsSinceSend > IDLE_AFTER_MIN) {
        // Quiet period (weekend on a Tue–Thu cadence, or a paused campaign).
        status = 'unknown';
        reason = `idle: last send ${minsSinceSend}m ago — no events expected`;

      } else if (lastEvent >= lastSend - SEND_GRACE_MIN * 60000) {
        status = 'healthy';
        reason = `events current (last event ${minsSinceEvent}m ago)`;

      } else if (minsSinceSend <= SVIX_RETRY_MIN) {
        status = 'warn';
        reason = `sends without events for ${minsSinceSend}m — within Svix 24h retry, should self-heal`;

      } else {
        status = 'fail';
        reason = `sends without events for ${minsSinceSend}m — past 24h retry, webhook delivery is broken`;
      }

      return res.status(200).json({
        status,
        reason,
        last_send_at:  lastSend  ? new Date(lastSend).toISOString()  : null,
        last_event_at: lastEvent ? new Date(lastEvent).toISOString() : null,
        minutes_since_send:  minsSinceSend,
        minutes_since_event: minsSinceEvent,
        checked_at: new Date(now).toISOString(),
      });

    } catch (err) {
      return res.status(200).json({
        status: 'fail',
        reason: `health query error: ${err.message}`,
        checked_at: new Date().toISOString(),
      });
    }
  });

  return router;
}

module.exports = buildResendHealth;

// -----------------------------------------------------------------------------
// PER-PLATFORM WIRE-UP (in each server.js, reusing the singleton pool)
//
// ACC / LAW / CBE  — timestamped event-row model.
//   CONFIRM the real table/column names per backend before shipping.
//   const buildResendHealth = require('./routes/resend-health');
//   app.use(buildResendHealth(pool, {
//     lastSendSql:  `SELECT MAX(sent_at) AS ts FROM email_sends WHERE sent_at IS NOT NULL`,
//     lastEventSql: `SELECT MAX(received_at) AS ts FROM resend_events`,
//   }));
//
// INV (canadainvesting) — status-enum + campaign-counter model. REPOINT, no migration.
//   app.use(buildResendHealth(pool, {
//     lastSendSql:  `SELECT MAX(sent_at) AS ts FROM outreach_recipients WHERE sent_at IS NOT NULL`,
//     lastEventSql: `SELECT MAX(updated_at) AS ts FROM outreach_campaigns`,
//   }));
//   NOTE: outreach_campaigns.updated_at is the counter-bump proxy the diagnosis
//   used (resolved 2026-05-26). If outreach_recipients has an updated_at that
//   moves on every status transition, prefer it — it's a finer-grained signal.
// -----------------------------------------------------------------------------
