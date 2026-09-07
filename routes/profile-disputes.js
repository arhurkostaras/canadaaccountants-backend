// HTTP layer for the public "correct or remove this profile" flow and its
// admin side. State changes, rendering, and email content live in
// services/profile-disputes.js; this file only maps requests to them.
//
//   GET  /api/profiles/:id/dispute          public, HTML form
//   POST /api/profiles/:id/dispute          public, rate-limited, form or JSON
//   GET  /api/admin/disputes                admin JWT, open disputes
//   POST /api/admin/disputes/:id/resolve    admin JWT, {resolution}
//
// server.js mounts the router AFTER the /api/admin umbrella and also passes
// the admin middlewares in `adminAuth`, so the two admin routes are guarded
// twice, like every other admin route in the codebase.
//
// Emails: the acknowledgement to the requester and the [REMOVAL REQUEST]
// alert to the admin are sent after the transaction commits. A failed send is
// logged with console.error and reported in the response; it never undoes
// the hide, which is the part that has to hold.

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const disputes = require('../services/profile-disputes');

const STATUS_BY_CODE = {
  BAD_ID: 400, BAD_REASON: 400, BAD_EMAIL: 400, BAD_DETAILS: 400, BAD_RESOLUTION: 400,
  NOT_FOUND: 404, ALREADY_RESOLVED: 409,
};

function wantsHtml(req) {
  if (req.is('application/x-www-form-urlencoded')) return true;
  if (req.is('json')) return false;
  return req.accepts(['json', 'html']) === 'html';
}

function createProfileDisputeRoutes({ getPool, sendEmail, adminAuth = [], logger = console } = {}) {
  if (typeof getPool !== 'function') throw new Error('createProfileDisputeRoutes: getPool is required');
  if (typeof sendEmail !== 'function') throw new Error('createProfileDisputeRoutes: sendEmail is required');

  const router = express.Router();
  const { PLATFORM } = disputes;

  // Per-IP: a real requester sends one form, maybe twice. trust proxy is set
  // in server.js so req.ip is the client, not Railway's edge.
  const postLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this address. Please try again in an hour.' },
  });

  async function sendDisputeEmails(result) {
    const out = { acknowledgement: false, alert: false };
    const ack = disputes.ackEmail(result);
    try {
      const r = await sendEmail({ to: result.dispute.requester_email, subject: ack.subject, html: ack.html, text: ack.text, from: PLATFORM.fromEmail, replyTo: PLATFORM.adminEmail });
      out.acknowledgement = !!(r && r.success);
      if (!out.acknowledgement) logger.error(`[ProfileDispute] acknowledgement send FAILED for D-${result.dispute.id} to ${result.dispute.requester_email}: ${JSON.stringify(r)}`);
    } catch (e) {
      logger.error(`[ProfileDispute] acknowledgement send threw for D-${result.dispute.id}: ${e.message}`);
    }
    const alert = disputes.alertEmail(result);
    try {
      const r = await sendEmail({ to: PLATFORM.adminEmail, subject: alert.subject, html: alert.html, text: alert.text, from: PLATFORM.fromEmail, replyTo: result.dispute.requester_email });
      out.alert = !!(r && r.success);
      if (!out.alert) logger.error(`[ProfileDispute] ADMIN ALERT send FAILED for D-${result.dispute.id}: ${JSON.stringify(r)}`);
    } catch (e) {
      logger.error(`[ProfileDispute] ADMIN ALERT send threw for D-${result.dispute.id}: ${e.message}`);
    }
    return out;
  }

  router.get('/api/profiles/:id/dispute', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (disputes.parseId(req.params.id) == null) {
        return res.status(400).type('html').send(disputes.renderErrorPage('Invalid profile', 'That profile link is not valid.'));
      }
      const profile = await disputes.getProfile(getPool(), req.params.id);
      if (!profile) return res.status(404).type('html').send(disputes.renderErrorPage('Profile not found', 'There is no profile with that id.'));
      return res.type('html').send(disputes.renderDisputePage({ profile }));
    } catch (e) {
      logger.error(`[ProfileDispute] GET form failed for id=${req.params.id}: ${e.message}`);
      return res.status(500).type('html').send(disputes.renderErrorPage('Something went wrong', `Please email ${PLATFORM.adminEmail} and we will handle it by hand.`));
    }
  });

  router.post('/api/profiles/:id/dispute', postLimiter, express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body || {};
    const html = wantsHtml(req);
    const input = {
      profileId: req.params.id,
      reason: body.reason,
      details: body.details,
      requesterEmail: body.email != null ? body.email : body.requester_email,
      requesterIp: req.ip,
    };
    try {
      const result = await disputes.openDispute(getPool(), input);
      logger.warn(`[ProfileDispute] OPENED D-${result.dispute.id} profile=${result.profile.id} reason=${result.dispute.reason} suppressed=${result.suppressed.length}${result.alreadyHidden ? ` (already ${result.alreadyHidden})` : ''}`);
      const emails = await sendDisputeEmails(result);
      if (html) return res.status(201).type('html').send(disputes.renderResultPage(result));
      return res.status(201).json({
        ok: true,
        dispute_id: result.dispute.id,
        profile_id: result.profile.id,
        hidden: true,
        suppressed: result.suppressed.length,
        emails,
      });
    } catch (e) {
      const status = STATUS_BY_CODE[e.code] || 500;
      if (status === 500) logger.error(`[ProfileDispute] POST failed for id=${req.params.id}: ${e.message}`);
      if (!html) return res.status(status).json({ error: e.message, code: e.code || 'ERROR' });
      if (status === 400 || status === 409) {
        const profile = disputes.parseId(req.params.id) != null ? await disputes.getProfile(getPool(), req.params.id).catch(() => null) : null;
        if (profile) return res.status(status).type('html').send(disputes.renderDisputePage({ profile, error: e.message, values: { reason: body.reason, details: body.details, email: input.requesterEmail } }));
      }
      if (status === 404) return res.status(404).type('html').send(disputes.renderErrorPage('Profile not found', 'There is no profile with that id.'));
      return res.status(status).type('html').send(disputes.renderErrorPage('Something went wrong', `Your request was not saved. Please email ${PLATFORM.adminEmail} and we will handle it by hand.`));
    }
  });

  router.get('/api/admin/disputes', ...adminAuth, async (req, res) => {
    try {
      const open = await disputes.listOpen(getPool());
      res.json({ count: open.length, disputes: open });
    } catch (e) {
      logger.error(`[ProfileDispute] admin list failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/api/admin/disputes/:id/resolve', ...adminAuth, async (req, res) => {
    const body = req.body || {};
    const actor = req.user ? String(req.user.email || req.user.id || 'admin') : 'admin';
    try {
      const result = await disputes.resolveDispute(getPool(), { disputeId: req.params.id, resolution: body.resolution, resolvedBy: actor });
      logger.warn(`[ProfileDispute] RESOLVED D-${req.params.id} resolution=${body.resolution} profile=${result.dispute.profile_id} visible=${result.visible} other_open=${result.other_open} by=${actor}`);
      res.json({ ok: true, ...result });
    } catch (e) {
      const status = STATUS_BY_CODE[e.code] || 500;
      if (status === 500) logger.error(`[ProfileDispute] resolve failed for D-${req.params.id}: ${e.message}`);
      res.status(status).json({ error: e.message, code: e.code || 'ERROR' });
    }
  });

  return router;
}

module.exports = { createProfileDisputeRoutes, wantsHtml, STATUS_BY_CODE };
