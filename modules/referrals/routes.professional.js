// modules/referrals/routes.professional.js
// Dashboard-facing API (JWT). Mounted with the app's existing authenticateToken
// + requireCPA middleware, injected so the module never re-implements auth.
//
// req.user carries userId (users.id) + email; the referrer_pro_id we store is the
// cpa_profiles.id, resolved via cpa_profiles.user_id (existing convention).

'use strict';

const express = require('express');

function buildProfessionalRoutes({ pool, config, service, deps, auth }) {
  const router = express.Router();
  const { authenticateToken, requireCPA } = auth;

  // Resolve the caller's professional row. Returns null if not a claimed pro.
  async function resolvePro(req) {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, referral_code
         FROM ${config.PRO_TABLE} WHERE user_id = $1 LIMIT 1`,
      [req.user.userId]
    );
    return rows[0] || null;
  }

  // POST /api/rail/referrals - create an outbound referral (spec 5.1).
  router.post('/api/rail/referrals', authenticateToken, requireCPA, async (req, res) => {
    try {
      const pro = await resolvePro(req);
      if (!pro) return res.status(403).json({ error: 'No claimed professional profile for this account.' });
      const body = req.body || {};
      if (body.client_consented !== true) {
        return res.status(422).json({ error: 'Client consent is required to create a referral.' });
      }
      const result = await service.createReferral(pool, config, {
        target_platform: body.target_platform,
        client: body.client || {},
        need_category: body.need_category,
        need_notes: body.need_notes,
        referrerProId: pro.id,
        referrerName: [pro.first_name, pro.last_name].filter(Boolean).join(' ').trim() || null,
        referrerEmail: pro.email || null,
      }, deps);
      if (!result.ok) return res.status(result.code || 400).json({ error: result.message, existing: result.existing });
      return res.status(201).json(result.referral);
    } catch (err) {
      console.error('[referrals/pro] create error:', err.message);
      return res.status(500).json({ error: 'Could not create referral.' });
    }
  });

  // GET /api/rail/referrals?direction=&status=&page= - list mine.
  router.get('/api/rail/referrals', authenticateToken, requireCPA, async (req, res) => {
    try {
      const pro = await resolvePro(req);
      if (!pro) return res.status(403).json({ error: 'No claimed professional profile.' });
      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = 25;
      const offset = (page - 1) * limit;
      const params = [pro.id];
      let where;
      if (req.query.direction === 'received') {
        where = `matched_pro_id = $1 AND direction = 'inbound'`;
      } else if (req.query.direction === 'sent') {
        where = `referrer_pro_id = $1 AND direction = 'outbound'`;
      } else {
        where = `(referrer_pro_id = $1 OR matched_pro_id = $1)`;
      }
      if (req.query.status) {
        params.push(req.query.status);
        where += ` AND status = $${params.length}`;
      }
      params.push(limit, offset);
      const { rows } = await pool.query(
        `SELECT id, direction, source_platform, target_platform, need_category, status,
                client_name, client_province, matched_pro_id, created_at, updated_at,
                accept_deadline_at
           FROM network_referrals WHERE ${where}
          ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      // Privacy: list view shows first name + last initial only.
      const masked = rows.map((r) => {
        const showFull = ['accepted', 'connected', 'converted'].includes(r.status) && r.matched_pro_id === pro.id;
        const parts = String(r.client_name || '').trim().split(/\s+/);
        const short = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : (parts[0] || '');
        return { ...r, client_name: showFull ? r.client_name : short, client_email: undefined };
      });
      return res.json({ page, referrals: masked });
    } catch (err) {
      console.error('[referrals/pro] list error:', err.message);
      return res.status(500).json({ error: 'Could not list referrals.' });
    }
  });

  const proAction = (fn) => async (req, res) => {
    try {
      const pro = await resolvePro(req);
      if (!pro) return res.status(403).json({ error: 'No claimed professional profile.' });
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad referral id.' });
      const result = await fn(id, pro, req);
      if (!result.ok) return res.status(result.code || 400).json({ error: result.message });
      return res.json({ ok: true });
    } catch (err) {
      console.error('[referrals/pro] action error:', err.message);
      return res.status(500).json({ error: 'Action failed.' });
    }
  };

  router.post('/api/rail/referrals/:id/accept', authenticateToken, requireCPA,
    proAction((id, pro) => service.acceptReferral(pool, config, id, pro.id, deps)));

  router.post('/api/rail/referrals/:id/decline', authenticateToken, requireCPA,
    proAction((id, pro, req) => service.declineReferral(pool, config, id, pro.id, (req.body || {}).reason, deps)));

  router.post('/api/rail/referrals/:id/connected', authenticateToken, requireCPA,
    proAction((id, pro) => service.markConnected(pool, config, id, pro.id, deps)));

  // GET /api/rail/referrals/stats
  router.get('/api/rail/referrals/stats', authenticateToken, requireCPA, async (req, res) => {
    try {
      const pro = await resolvePro(req);
      if (!pro) return res.status(403).json({ error: 'No claimed professional profile.' });
      const [counts, credits, recip] = await Promise.all([
        pool.query(
          `SELECT
             count(*) FILTER (WHERE referrer_pro_id = $1 AND direction='outbound')::int AS sent,
             count(*) FILTER (WHERE matched_pro_id = $1 AND direction='inbound')::int AS received,
             count(*) FILTER (WHERE (referrer_pro_id=$1 OR matched_pro_id=$1) AND status='converted')::int AS converted
           FROM network_referrals`, [pro.id]),
        pool.query(`SELECT count(*) FILTER (WHERE status IN ('earned','applied'))::int AS earned FROM network_referral_credits WHERE pro_id = $1`, [pro.id]),
        pool.query(`SELECT reciprocity_score, network_badge FROM ${config.PRO_TABLE} WHERE id = $1`, [pro.id]),
      ]);
      return res.json({
        sent: counts.rows[0].sent,
        received: counts.rows[0].received,
        converted: counts.rows[0].converted,
        credits_earned: credits.rows[0].earned,
        reciprocity_score: recip.rows[0] ? Number(recip.rows[0].reciprocity_score) : 0,
        badge: recip.rows[0] ? recip.rows[0].network_badge : null,
      });
    } catch (err) {
      console.error('[referrals/pro] stats error:', err.message);
      return res.status(500).json({ error: 'Could not load stats.' });
    }
  });

  // GET /api/rail/referrals/link - referral code + shareable URL (lazily generated).
  router.get('/api/rail/referrals/link', authenticateToken, requireCPA, async (req, res) => {
    try {
      const pro = await resolvePro(req);
      if (!pro) return res.status(403).json({ error: 'No claimed professional profile.' });
      let code = pro.referral_code;
      if (!code) {
        code = await service.generateUniqueReferralCode(pool, config);
        await pool.query(`UPDATE ${config.PRO_TABLE} SET referral_code = $1 WHERE id = $2`, [code, pro.id]);
      }
      return res.json({ referral_code: code, url: `${config.PLATFORM_DOMAIN}/r/${code}` });
    } catch (err) {
      console.error('[referrals/pro] link error:', err.message);
      return res.status(500).json({ error: 'Could not load referral link.' });
    }
  });

  return router;
}

module.exports = buildProfessionalRoutes;
