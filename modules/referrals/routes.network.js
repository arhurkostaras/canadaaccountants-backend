// modules/referrals/routes.network.js
// Inbound server-to-server surface. ALL four endpoints are HMAC-gated - health
// and referral-code resolution leak platform/professional info otherwise, so
// there is no unauthenticated network surface (spec section 4.3).
//
// Router-factory convention, matching routes/resend-health.js:
//   app.use(buildNetworkRoutes({ pool, config, service, captureError }))

'use strict';

const express = require('express');
const hmac = require('./hmac');

const MODULE_VERSION = '1.0.0';

function buildNetworkRoutes({ pool, config, service, captureError }) {
  const router = express.Router();

  const logError = (context, err) => {
    // Never a silent catch on a write/verify path (global guardrail).
    console.error(`[referrals/network] ${context}:`, err && err.message ? err.message : err);
    if (typeof captureError === 'function') {
      try { captureError(err, { context }); } catch (e) { console.error('[referrals/network] captureError failed:', e.message); }
    }
  };

  const secrets = () => [config.NETWORK_SHARED_SECRET, config.NETWORK_SHARED_SECRET_NEXT];

  // Verify a POST whose signature covers the exact raw body bytes.
  function verifyPost(req) {
    const platform = req.headers['x-network-platform'];
    if (!platform || !config.peers[platform]) return { ok: false, reason: 'unknown peer platform' };
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const result = hmac.verify({
      secrets: secrets(),
      timestamp: req.headers['x-network-timestamp'],
      signature: req.headers['x-network-signature'],
      canonicalPayload: rawBody,
    });
    return { ...result, platform, rawBody };
  }

  // Verify a GET whose signature covers `${METHOD} ${path}?${query}`.
  function verifyGet(req) {
    const platform = req.headers['x-network-platform'];
    if (!platform || !config.peers[platform]) return { ok: false, reason: 'unknown peer platform' };
    const path = req.baseUrl + req.path;
    const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?') + 1) : '';
    const result = hmac.verify({
      secrets: secrets(),
      timestamp: req.headers['x-network-timestamp'],
      signature: req.headers['x-network-signature'],
      canonicalPayload: hmac.canonicalForGet('GET', path, query),
    });
    return { ...result, platform };
  }

  // --- POST /api/network/referrals : receive a new referral from a peer -------
  router.post('/api/network/referrals', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    const v = verifyPost(req);
    if (!v.ok) {
      logError('inbound referral auth failure', new Error(v.reason));
      return res.status(401).json({ error: 'unauthorized' });
    }
    let payload;
    try {
      payload = JSON.parse(v.rawBody);
    } catch (err) {
      logError('inbound referral malformed JSON', err);
      return res.status(400).json({ error: 'malformed JSON' });
    }
    try {
      const result = await service.receiveReferral(pool, config, payload, v.platform);
      // Idempotent: duplicate delivery returns 200 with the existing record.
      return res.status(result.created ? 201 : 200).json({ network_ref_id: result.network_ref_id, status: result.status });
    } catch (err) {
      logError('inbound referral processing', err);
      return res.status(500).json({ error: 'referral processing failed' });
    }
  });

  // --- POST /api/network/referrals/:networkRefId/status : status update -------
  router.post('/api/network/referrals/:networkRefId/status', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    const v = verifyPost(req);
    if (!v.ok) {
      logError('inbound status auth failure', new Error(v.reason));
      return res.status(401).json({ error: 'unauthorized' });
    }
    let payload;
    try {
      payload = JSON.parse(v.rawBody);
    } catch (err) {
      logError('inbound status malformed JSON', err);
      return res.status(400).json({ error: 'malformed JSON' });
    }
    try {
      await service.receiveStatusUpdate(pool, config, req.params.networkRefId, payload, v.platform);
      return res.status(200).json({ ok: true });
    } catch (err) {
      logError('inbound status processing', err);
      return res.status(500).json({ error: 'status processing failed' });
    }
  });

  // --- GET /api/network/referral-codes/:code : resolve a local referral code --
  router.get('/api/network/referral-codes/:code', async (req, res) => {
    const v = verifyGet(req);
    if (!v.ok) {
      logError('code resolve auth failure', new Error(v.reason));
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const resolved = await service.resolveLocalCode(pool, config, req.params.code);
      return res.status(200).json(resolved); // { valid, platform, pro_id, pro_name }
    } catch (err) {
      logError('code resolve', err);
      return res.status(500).json({ error: 'code resolution failed' });
    }
  });

  // --- GET /api/network/health : authenticated peer healthcheck ---------------
  router.get('/api/network/health', async (req, res) => {
    const v = verifyGet(req);
    if (!v.ok) {
      logError('health auth failure', new Error(v.reason));
      return res.status(401).json({ error: 'unauthorized' });
    }
    return res.status(200).json({
      platform: config.PLATFORM_ID,
      version: MODULE_VERSION,
      notify_enabled: config.NOTIFY_ENABLED,
      time: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = buildNetworkRoutes;
module.exports.MODULE_VERSION = MODULE_VERSION;
