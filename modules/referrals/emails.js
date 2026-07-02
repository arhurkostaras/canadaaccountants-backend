// modules/referrals/emails.js
// All referral email goes through here, and EVERY send gates on
// config.NOTIFY_ENABLED (spec 11.0). With the flag off the rail runs fully dark:
// the template is rendered and logged as referral_events('email_suppressed_dark')
// with the rendered subject+html in detail, and ZERO mail leaves the platform.
//
// buildNotify({ config, sendEmail, service, captureError }) -> { offerToPro,
//   introToClient, statusToReferrer }. sendEmail is the injected services/email.js
// sendEmail({ to, subject, html, from, replyTo }).

'use strict';

// Verbatim network disclosure (spec 12.2) - present in every client-facing send.
const DISCLOSURE =
  'CanadaAccountants, CanadaLawyers, CanadaInvesting and Canada Business Exits are ' +
  'operated by the same owner. Introductions between them are tracked. Professionals ' +
  'may receive non-cash platform benefits (such as subscription credits) for referrals. ' +
  'You are never obligated to engage anyone we introduce.';

const SENDER_ID = 'CanadaAccountants.app | Toronto, ON, Canada';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

// --- templates (return { subject, html }) ----------------------------------

function tplOfferToPro(config, referral) {
  const subject = `New referred client: ${esc(referral.need_category)} in ${esc(referral.client_province || 'Canada')} - respond within 48h`;
  const html = `
    <p>You have a new referred client on ${esc(config.PLATFORM_NAME)}.</p>
    <p><strong>Referred by:</strong> ${esc(referral.referrer_name || 'a network professional')} (${esc(referral.source_platform)})<br>
       <strong>Need:</strong> ${esc(referral.need_category)}<br>
       <strong>Province:</strong> ${esc(referral.client_province || 'n/a')}<br>
       <strong>Client:</strong> ${esc(firstName(referral.client_name))}.</p>
    <p>Referred clients convert better than cold leads and accepting affects your network ranking.
       You have 48 hours to accept before this re-matches.</p>
    <p><a href="${esc(config.PLATFORM_DOMAIN)}/dashboard#referrals">Accept or decline in your dashboard</a></p>
    <hr><p style="color:#888;font-size:12px;">${esc(SENDER_ID)}</p>`;
  return { subject, html };
}

function tplIntroToClient(config, referral) {
  const subject = `${referral.referrer_name || 'A colleague'} asked us to introduce you to a ${config.PRO_NOUN}`;
  const html = `
    <p>Hi ${esc(firstName(referral.client_name))},</p>
    <p>${esc(referral.referrer_name || 'A colleague')} asked us to introduce you to a
       ${esc(config.PRO_NOUN)} for ${esc(referral.need_category)}.</p>
    <p>The professional we matched you with will reach out within one business day, or you can
       reply directly to this email to connect now.</p>
    <p>This is a one-time introduction made at ${esc(referral.referrer_name || 'your contact')}'s request.
       We won't add you to any list, and you can opt out of any further contact here:
       {{unsubscribe_url}}.</p>
    <hr>
    <p style="color:#666;font-size:12px;">${esc(DISCLOSURE)}</p>
    <p style="color:#888;font-size:12px;">${esc(SENDER_ID)} &middot; <a href="{{unsubscribe_url}}">Unsubscribe</a></p>`;
  return { subject, html };
}

function tplStatusToReferrer(config, referral, status) {
  const subject = `Your referral was ${esc(status)}`;
  const html = `
    <p>Update on the client you referred to ${esc(referral.target_platform)}:
       the referral is now <strong>${esc(status)}</strong>.</p>
    ${status === 'converted' ? '<p>A subscription credit has been recorded on your account.</p>' : ''}
    <hr><p style="color:#888;font-size:12px;">${esc(SENDER_ID)} &middot; <a href="{{unsubscribe_url}}">Unsubscribe</a></p>`;
  return { subject, html };
}

function buildNotify({ config, sendEmail, service, captureError }) {
  // One gated path for every send. Dark -> log + return. Live -> suppression + send.
  async function gatedSend(pool, referral, recipient, template, eventKind) {
    if (!config.NOTIFY_ENABLED) {
      // DARK: render + record, never send. This log IS the Phase 1 proof.
      await service.recordEvent(pool, referral.id, 'email_suppressed_dark', {
        would_send_to: recipient,
        template: eventKind,
        subject: template.subject,
        html: template.html,
        reason: `REFERRAL_NOTIFY_ENABLED=false on ${config.PLATFORM_ID}`,
      });
      return { sent: false, dark: true };
    }

    // LIVE path (only reached once a platform is explicitly enabled in writing).
    if (!recipient) {
      await service.recordEvent(pool, referral.id, 'error', { stage: eventKind, message: 'no recipient' });
      return { sent: false };
    }
    try {
      const suppressed = await pool.query(
        `SELECT 1 FROM ${config.SUPPRESSION_TABLE} WHERE lower(${config.SUPPRESSION_EMAIL_COL}) = $1 LIMIT 1`,
        [String(recipient).toLowerCase()]
      );
      if (suppressed.rows.length > 0) {
        await service.recordEvent(pool, referral.id, 'error', { stage: eventKind, message: 'recipient suppressed' });
        return { sent: false, suppressed: true };
      }
      await sendEmail({ to: recipient, subject: template.subject, html: template.html });
      await service.recordEvent(pool, referral.id, eventKind === 'intro_to_client' ? 'intro_email_sent'
        : eventKind === 'offer_to_pro' ? 'offer_email_sent' : 'status_email_sent', { to: recipient });
      return { sent: true };
    } catch (err) {
      console.error(`[referrals/emails] send failed (${eventKind}):`, err.message);
      if (typeof captureError === 'function') { try { captureError(err, { stage: eventKind }); } catch (e) { console.error('[referrals/emails] captureError failed:', e.message); } }
      await service.recordEvent(pool, referral.id, 'error', { stage: eventKind, message: err.message });
      return { sent: false, error: err.message };
    }
  }

  return {
    offerToPro: (pool, cfg, referral) =>
      gatedSend(pool, referral, referral.matched_pro_email || null, tplOfferToPro(cfg, referral), 'offer_to_pro'),
    introToClient: (pool, cfg, referral) =>
      gatedSend(pool, referral, referral.client_email, tplIntroToClient(cfg, referral), 'intro_to_client'),
    statusToReferrer: (pool, cfg, referral, status) =>
      gatedSend(pool, referral, referral.referrer_email || null, tplStatusToReferrer(cfg, referral, status), 'status_to_referrer'),
  };
}

module.exports = { buildNotify, DISCLOSURE };
