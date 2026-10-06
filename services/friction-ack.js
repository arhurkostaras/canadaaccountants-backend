// Copy for the two emails sent when a client submits a match request
// (POST /api/friction/sme-match-request): the acknowledgement to the client
// and the alert to Arthur. Pure functions, so the wording is testable.
//
// The acknowledgement has two variants:
//   - matches found: an introduction within 1 business day, as before.
//   - no matches:    no promise we cannot keep. Arthur looks personally, and
//                    the client is pointed to their provincial CPA body's
//                    public register in the meantime. Same fix as LAW, where an
//                    urgent request with zero eligible lawyers was told to
//                    expect an introduction the next business day.
// The pain point is shown as a phrase ("tax"), never as the form slug
// ("tax-stress").

'use strict';

const { provinceFromText } = require('./cpa-match-eligibility');

const PROVINCE_NAMES = {
  ON: 'Ontario', QC: 'Quebec', BC: 'British Columbia', AB: 'Alberta', SK: 'Saskatchewan',
  MB: 'Manitoba', NS: 'Nova Scotia', NB: 'New Brunswick', PE: 'Prince Edward Island',
  NL: 'Newfoundland and Labrador', YT: 'Yukon', NT: 'Northwest Territories', NU: 'Nunavut',
};

const PAIN_POINT_PHRASES = {
  'time-drain': 'bookkeeping and day-to-day accounting',
  'tax-stress': 'tax',
  'financial-chaos': 'getting your finances in order',
  'cpa-search': 'finding a CPA',
};

const P = 'margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;';
const ROW = 'margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function painPointPhrase(painPoint) {
  if (!painPoint || painPoint === 'general') return null;
  return PAIN_POINT_PHRASES[painPoint] || String(painPoint).replace(/[-_]+/g, ' ').trim();
}

// { city, province (code or null), label ("Paradise, NL" / "your area") }
function requestLocation(contactInfo) {
  const ci = contactInfo || {};
  const province = provinceFromText(ci.province) || provinceFromText(ci.location);
  const city = ci.city || (ci.location ? String(ci.location).split(',')[0].trim() : null) || null;
  const label = [city, province].filter(Boolean).join(', ') || ci.location || null;
  return { city, province, label };
}

function requesterAck({ request, matchCount }) {
  const ci = request.contactInfo || {};
  const loc = requestLocation(ci);
  const topic = painPointPhrase(request.painPoint);
  const hi = `Hi ${escapeHtml(ci.name || 'there')},`;
  const about = topic ? ` about ${escapeHtml(topic)}` : '';
  const sign = `<p style="margin:0;color:#333333;font-size:15px;line-height:1.7;">Arthur Kostaras<br>Founder, CanadaAccountants.app<br>Victoria, BC, Canada</p>`;
  const footer = `<p style="margin:18px 0 0;color:#888888;font-size:12px;line-height:1.6;">You're receiving this because you submitted a match request at canadaaccountants.app. We use your details only to match you with a CPA and follow up. <a href="https://canadaaccountants.app/privacy-policy" style="color:#2563eb;">Privacy policy</a> &middot; reply "unsubscribe" to opt out.</p>`;

  if (matchCount > 0) {
    return {
      subject: `We've got your request — a CPA match in ${loc.label || 'your area'}`,
      body: `<p style="${P}">${hi}</p>
        <p style="${P}">Thanks for reaching out${about}. Here's exactly what happens next: I'll match you with a CPA who fits &mdash; you'll have an introduction in your inbox within 1 business day. I personally review every request at this stage, so a real person (me) is reading yours. If you want to add anything, just reply to this email; it comes straight to me.</p>
        ${sign}${footer}`,
    };
  }

  const where = loc.province ? PROVINCE_NAMES[loc.province] : 'your province';
  return {
    subject: 'We\'ve got your request — an update from CanadaAccountants.app',
    body: `<p style="${P}">${hi}</p>
      <p style="${P}">Thanks for reaching out${about}. I want to be straight with you: we don't yet have a CPA in ${escapeHtml(where)} on CanadaAccountants.app who fits your request. I personally review every request, and I'm looking for one for you now. If I find a good fit, I'll email you directly.</p>
      <p style="${P}">So you're not left waiting, the provincial CPA body in ${escapeHtml(where)} keeps a public register of licensed CPAs and firms, which you can search for one near you.</p>
      <p style="${P}">If you'd like to add anything about your situation, just reply to this email; it comes straight to me.</p>
      ${sign}${footer}`,
  };
}

function adminAlert({ requestId, request, matches }) {
  const ci = request.contactInfo || {};
  const loc = requestLocation(ci);
  const who = ci.name || requestId;
  const flag = matches.length === 0 ? ' — 0 matches, manual intro needed' : ` — ${matches.length} match${matches.length === 1 ? '' : 'es'}`;
  const matchList = matches
    .map(m => `<li><strong>${escapeHtml(m.name)}</strong> — ${escapeHtml((m.specializations || []).join(', '))} (${Number(m.matchScore || 0).toFixed(0)}% match)</li>`)
    .join('');
  const row = (k, v) => `<p style="${ROW}"><strong>${k}:</strong> ${escapeHtml(v || 'N/A')}</p>`;
  return {
    subject: `New SME Match Request: ${who}${loc.label ? ` (${loc.label})` : ''}${flag}`,
    body: `<h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">New Friction Elimination Match Request</h2>
      ${row('Request ID', requestId)}
      ${row('Contact', `${ci.name || 'N/A'} (${ci.email || 'N/A'})`)}
      ${row('Location', loc.label)}
      ${row('Pain Point', request.painPoint || request.pain_point)}
      ${row('Business Type', request.businessType || request.business_type)}
      ${row('Urgency', request.urgencyLevel || request.urgency_level)}
      <h3 style="margin:18px 0 12px;color:#1a1a1a;font-size:17px;font-weight:600;">Matches Generated (${matches.length})</h3>
      ${matches.length
        ? `<ul style="margin:0 0 18px;color:#333333;font-size:15px;line-height:1.7;">${matchList}</ul>`
        : `<p style="${ROW}"><strong>No eligible CPA.</strong> The client was told we have no match yet and pointed to their provincial CPA body's public register. Reply to them personally if you find one.</p>`}`,
  };
}

module.exports = { requesterAck, adminAlert, painPointPhrase, requestLocation };
