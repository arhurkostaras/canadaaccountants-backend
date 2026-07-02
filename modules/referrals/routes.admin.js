// modules/referrals/routes.admin.js
// Admin surface. Paths live under /api/admin/* and inherit the existing
// `app.use('/api/admin', authenticateToken, requireAdmin)` umbrella in server.js,
// so they are admin-gated by mount. Every mutating action writes referral_events.

'use strict';

const express = require('express');

function buildAdminRoutes({ pool, config, service, incentives }) {
  const router = express.Router();

  // GET /api/admin/referrals - recent referrals with status + ages.
  router.get('/api/admin/referrals', async (req, res) => {
    try {
      const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
      const { rows } = await pool.query(
        `SELECT id, network_ref_id, direction, source_platform, target_platform, status,
                need_category, client_province, referrer_name, matched_pro_id, match_attempts,
                created_at, updated_at,
                EXTRACT(EPOCH FROM (now() - created_at))/60 AS age_minutes
           FROM network_referrals ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return res.json({ referrals: rows });
    } catch (err) {
      console.error('[referrals/admin] list error:', err.message);
      return res.status(500).json({ error: 'list failed' });
    }
  });

  // GET /api/admin/referral-credits?status=pending_review
  router.get('/api/admin/referral-credits', async (req, res) => {
    try {
      const params = [];
      let where = '';
      if (req.query.status) { params.push(req.query.status); where = `WHERE status = $1`; }
      const { rows } = await pool.query(
        `SELECT * FROM network_referral_credits ${where} ORDER BY created_at DESC LIMIT 100`, params
      );
      return res.json({ credits: rows });
    } catch (err) {
      console.error('[referrals/admin] credits list error:', err.message);
      return res.status(500).json({ error: 'list failed' });
    }
  });

  // POST /api/admin/referral-credits/:id/review { decision: 'approve'|'reject', note }
  router.post('/api/admin/referral-credits/:id/review', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { decision, note } = req.body || {};
      if (!['approve', 'reject'].includes(decision)) return res.status(422).json({ error: 'decision must be approve|reject' });
      const result = await incentives.reviewSelfReportedCredit(pool, config, id, decision, req.user && req.user.email, note);
      if (!result.ok) return res.status(409).json({ error: result.message });
      return res.json(result);
    } catch (err) {
      console.error('[referrals/admin] credit review error:', err.message);
      return res.status(500).json({ error: 'review failed' });
    }
  });

  // POST /api/admin/referrals/:id/redact - PIPEDA erasure (keep aggregates + events).
  router.post('/api/admin/referrals/:id/redact', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rows } = await pool.query(
        `UPDATE network_referrals SET client_name = NULL, client_email = NULL, client_phone = NULL, updated_at = now()
          WHERE id = $1 RETURNING client_email`, [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'not found' });
      // Also redact link_attributions rows carrying this address, if any survived.
      await service.recordEvent(pool, id, 'cancelled', { redacted: true, by: req.user && req.user.email });
      return res.json({ ok: true });
    } catch (err) {
      console.error('[referrals/admin] redact error:', err.message);
      return res.status(500).json({ error: 'redact failed' });
    }
  });

  return router;
}

// Status summary for the daily monitoring endpoint (spec 13.2). Reusable so
// server.js can splice it into the existing /api/admin/status payload.
async function getStatusSummary(pool) {
  const { rows } = await pool.query(`
    SELECT
      count(*) FILTER (WHERE direction='outbound' AND created_at > now() - interval '7 days')::int AS sent_7d,
      count(*) FILTER (WHERE direction='inbound'  AND created_at > now() - interval '7 days')::int AS received_7d,
      count(*) FILTER (WHERE status='accepted'    AND updated_at > now() - interval '7 days')::int AS accepted_7d,
      count(*) FILTER (WHERE status='converted')::int AS converted_total
    FROM network_referrals`);
  const outbox = await pool.query(`
    SELECT count(*)::int AS pending,
           COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at)))/60, 0)::int AS oldest_minutes
      FROM network_outbox WHERE delivered_at IS NULL`);
  return {
    sent_7d: rows[0].sent_7d,
    received_7d: rows[0].received_7d,
    accepted_7d: rows[0].accepted_7d,
    converted_total: rows[0].converted_total,
    outbox_pending: outbox.rows[0].pending,
    oldest_undelivered_minutes: outbox.rows[0].oldest_minutes,
  };
}

module.exports = buildAdminRoutes;
module.exports.getStatusSummary = getStatusSummary;
