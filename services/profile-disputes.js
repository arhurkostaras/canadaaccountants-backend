// Profile disputes: the public "correct or remove this profile" flow (ACC).
//
// A person named on a public profile (or someone writing on their behalf)
// submits a dispute from /api/profiles/:id/dispute. In one transaction the
// profile is hidden (dispute_pending = true), every address on the row goes on
// the outreach suppression list (reason 'dispute'), and the request is stored
// in profile_disputes. The route layer then sends the requester an
// acknowledgement and the admin a [REMOVAL REQUEST] alert. An admin resolves
// the dispute as removed (removed_at set, hidden for good), corrected, or
// restored (visible again).
//
// Visibility is enforced in server.js by the existing 410 gate on
// /api/profiles/:id and /api/claim/profile/:refToken (hiddenReason + sendGone
// below) and by VISIBLE_SQL in every public listing query (sitemap, directory,
// search, related). This module owns the state machine and the rendered
// pages/emails; routes/profile-disputes.js owns HTTP.
//
// The same module is deployed on all three backends (ACC, ACC, INV); only the
// PLATFORM block differs.

'use strict';

const fs = require('fs');
const path = require('path');

const PLATFORM = {
  code: 'ACC',
  name: 'CanadaAccountants',
  table: 'scraped_cpas',
  noun: 'cpa',
  frontendUrl: process.env.FRONTEND_URL || 'https://canadaaccountants.app',
  backendUrl: process.env.BACKEND_URL || 'https://canadaaccountants-backend-production-1d8f.up.railway.app',
  fromEmail: process.env.FROM_EMAIL || 'noreply@canadaaccountants.app',
  adminEmail: process.env.ADMIN_EMAIL || 'arthur@negotiateandwin.com',
  migration: path.join(__dirname, '..', 'migrations', '005-profile-disputes.sql'),
};

const REASONS = {
  remove: 'Remove my profile',
  correct: 'Correct information on my profile',
  not_private_practice: 'I am not in private practice',
  other: 'Other',
};
const RESOLUTIONS = ['removed', 'corrected', 'restored'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_DETAILS = 4000;
const SUPPRESSION_REASON = 'dispute';
const DECISION_WINDOW = 'three business days';

// Predicate every public listing query appends. Alias is the table alias with
// its dot ('p.'), or '' for an unaliased FROM.
function visibleSql(alias = '') {
  return `(${alias}removed_at IS NULL AND ${alias}dispute_pending = false)`;
}
const VISIBLE_SQL = visibleSql('');

function disputeUrl(profileId) {
  return `${PLATFORM.backendUrl}/api/profiles/${profileId}/dispute`;
}

function profileUrl(profileId) {
  return `${PLATFORM.frontendUrl}/profile?id=${profileId}`;
}

// Same fallback chain the 410 gate in server.js uses for its display name.
function displayName(row) {
  if (!row) return 'this professional';
  return (((row.first_name || '') + ' ' + (row.last_name || '')).trim()) || row.full_name || 'this professional';
}

// 'removed' | 'dispute_pending' | null. Feeds the existing 410 gate.
function hiddenReason(row) {
  if (!row) return null;
  if (row.removed_at) return 'removed';
  if (row.dispute_pending === true) return 'dispute_pending';
  return null;
}

// 410 for a hidden profile. Carries no personal data: the whole point of the
// request is that the person's details stop being served.
function sendGone(res, routeLabel, row) {
  const reason = hiddenReason(row) || 'removed';
  console.warn(`[${routeLabel}] 410 PROFILE_REMOVED: id=${row.id} reason=${reason}`);
  res.set('Cache-Control', reason === 'removed' ? 'public, max-age=86400' : 'no-store');
  return res.status(410).json({
    error: 'Profile removed',
    code: 'PROFILE_REMOVED',
    message: reason === 'removed'
      ? 'This profile was removed at the request of the person it describes and will not be re-listed.'
      : 'This profile is hidden while a correction or removal request is reviewed.',
  });
}

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseId(id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n) || n <= 0 || String(id).trim() !== String(n)) return null;
  return n;
}

function isValidEmail(s) {
  return typeof s === 'string' && s.length <= 255 && EMAIL_RE.test(s.trim());
}

async function ensureSchema(pool) {
  const sql = fs.readFileSync(PLATFORM.migration, 'utf8');
  await pool.query(sql);
}

async function getProfile(pool, id) {
  const n = parseId(id);
  if (n == null) return null;
  const r = await pool.query(
    `SELECT id, first_name, last_name, full_name, firm_name, city, province, email, enriched_email,
            claim_status, dispute_pending, removed_at
       FROM ${PLATFORM.table} WHERE id = $1`,
    [n]
  );
  return r.rows[0] || null;
}

function rowEmails(row) {
  const out = new Set();
  for (const e of [row.email, row.enriched_email]) {
    const v = typeof e === 'string' ? e.trim().toLowerCase() : '';
    if (v && EMAIL_RE.test(v)) out.add(v);
  }
  return Array.from(out);
}

// Validate the public form input. Throws err(BAD_*) with a message the form
// can show back to the requester.
function validateDisputeInput({ profileId, reason, details, requesterEmail }) {
  const id = parseId(profileId);
  if (id == null) throw err('BAD_ID', 'Profile id must be a positive integer.');
  if (!Object.prototype.hasOwnProperty.call(REASONS, reason)) {
    throw err('BAD_REASON', `Reason must be one of: ${Object.keys(REASONS).join(', ')}.`);
  }
  const email = typeof requesterEmail === 'string' ? requesterEmail.trim().toLowerCase() : '';
  if (!isValidEmail(email)) throw err('BAD_EMAIL', 'Please enter a valid email address so we can confirm the outcome to you.');
  const text = details == null ? '' : String(details).trim();
  if (text.length > MAX_DETAILS) throw err('BAD_DETAILS', `Details must be ${MAX_DETAILS} characters or fewer.`);
  return { id, reason, email, details: text || null };
}

// Hide the profile, suppress its addresses, record the dispute. One
// transaction, row lock held so two simultaneous submissions serialise.
async function openDispute(pool, input) {
  const v = validateDisputeInput(input);
  const ip = input.requesterIp ? String(input.requesterIp).slice(0, 64) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, first_name, last_name, full_name, firm_name, city, province, email, enriched_email,
              claim_status, dispute_pending, removed_at
         FROM ${PLATFORM.table} WHERE id = $1 FOR UPDATE`,
      [v.id]
    );
    if (found.rows.length === 0) throw err('NOT_FOUND', `Profile ${v.id} not found.`);
    const profile = found.rows[0];
    const alreadyHidden = hiddenReason(profile);

    await client.query(`UPDATE ${PLATFORM.table} SET dispute_pending = true WHERE id = $1`, [v.id]);
    const ins = await client.query(
      `INSERT INTO profile_disputes (profile_id, reason, details, requester_email, requester_ip)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [v.id, v.reason, v.details, v.email, ip]
    );
    const suppressed = [];
    for (const email of rowEmails(profile)) {
      const r = await client.query(
        `INSERT INTO outreach_unsubscribes (email, reason, unsubscribed_at) VALUES ($1, $2, NOW())
         ON CONFLICT (email) DO NOTHING`,
        [email, SUPPRESSION_REASON]
      );
      suppressed.push({ email, inserted: (r.rowCount || 0) === 1 });
    }
    await client.query('COMMIT');
    return { dispute: ins.rows[0], profile: { ...profile, dispute_pending: true }, suppressed, alreadyHidden };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (rb) { console.error(`[ProfileDispute] rollback failed: ${rb.message}`); }
    throw e;
  } finally {
    client.release();
  }
}

// Resolve one dispute and apply its effect to the profile.
//   removed   -> removed_at set (kept if already set), hidden permanently
//   corrected -> visible again (removed_at cleared)
//   restored  -> visible again (removed_at cleared)
// A profile with another dispute still open stays hidden (dispute_pending
// stays true) until that one is resolved too; the result reports it.
async function resolveDispute(pool, { disputeId, resolution, resolvedBy }) {
  const id = parseId(disputeId);
  if (id == null) throw err('BAD_ID', 'Dispute id must be a positive integer.');
  if (!RESOLUTIONS.includes(resolution)) throw err('BAD_RESOLUTION', `resolution must be one of: ${RESOLUTIONS.join(', ')}.`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM profile_disputes WHERE id = $1 FOR UPDATE', [id]);
    if (found.rows.length === 0) throw err('NOT_FOUND', `Dispute ${id} not found.`);
    if (found.rows[0].resolved_at) throw err('ALREADY_RESOLVED', `Dispute ${id} was already resolved as ${found.rows[0].resolution}.`);
    const profileId = found.rows[0].profile_id;

    const upd = await client.query(
      `UPDATE profile_disputes SET resolved_at = NOW(), resolution = $2, resolved_by = $3 WHERE id = $1 RETURNING *`,
      [id, resolution, resolvedBy ? String(resolvedBy).slice(0, 255) : null]
    );
    const others = await client.query(
      'SELECT COUNT(*)::int AS n FROM profile_disputes WHERE profile_id = $1 AND resolved_at IS NULL AND id <> $2',
      [profileId, id]
    );
    const otherOpen = others.rows[0].n;

    let profile;
    if (resolution === 'removed') {
      profile = await client.query(
        `UPDATE ${PLATFORM.table} SET removed_at = COALESCE(removed_at, NOW()), dispute_pending = $2
          WHERE id = $1 RETURNING id, dispute_pending, removed_at`,
        [profileId, otherOpen > 0]
      );
    } else {
      profile = await client.query(
        `UPDATE ${PLATFORM.table} SET removed_at = NULL, dispute_pending = $2
          WHERE id = $1 RETURNING id, dispute_pending, removed_at`,
        [profileId, otherOpen > 0]
      );
    }
    await client.query('COMMIT');
    return {
      dispute: upd.rows[0],
      profile: profile.rows[0] || null,   // null if the row was hard-deleted in the meantime
      other_open: otherOpen,
      visible: !!(profile.rows[0] && !hiddenReason(profile.rows[0])),
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (rb) { console.error(`[ProfileDispute] rollback failed: ${rb.message}`); }
    throw e;
  } finally {
    client.release();
  }
}

async function listOpen(pool) {
  const r = await pool.query(
    `SELECT d.id, d.profile_id, d.reason, d.details, d.requester_email, d.created_at,
            p.id AS p_id, p.first_name, p.last_name, p.full_name, p.firm_name, p.city, p.province,
            p.claim_status, p.dispute_pending, p.removed_at
       FROM profile_disputes d
       LEFT JOIN ${PLATFORM.table} p ON p.id = d.profile_id
      WHERE d.resolved_at IS NULL
      ORDER BY d.created_at ASC`
  );
  return r.rows.map((row) => ({
    id: row.id,
    profile_id: row.profile_id,
    reason: row.reason,
    details: row.details,
    requester_email: row.requester_email,
    created_at: row.created_at,
    profile: row.p_id == null
      ? null   // row hard-deleted since the dispute was opened
      : {
          display_name: displayName(row),
          firm_name: row.firm_name,
          city: row.city,
          province: row.province,
          claim_status: row.claim_status,
          hidden: hiddenReason(row),
          url: profileUrl(row.profile_id),
        },
    resolve_url: `${PLATFORM.backendUrl}/api/admin/disputes/${row.id}/resolve`,
  }));
}

// ---------------------------------------------------------------- rendering

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  body { margin: 0; padding: 32px 16px; background: #f4f4f7; color: #1a1a1a; font: 15px/1.6 Arial, "Helvetica Neue", Helvetica, sans-serif; }
  main { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px 36px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0 0 14px; }
  .muted { color: #666; font-size: 13px; }
  .error { background: #fdecea; color: #7a1f1a; border-radius: 6px; padding: 10px 14px; margin: 0 0 16px; }
  .ok { background: #e8f5e9; color: #1b5e20; border-radius: 6px; padding: 10px 14px; margin: 0 0 16px; }
  fieldset { border: 0; padding: 0; margin: 0 0 18px; }
  legend, label.block { display: block; font-weight: 600; margin: 0 0 6px; }
  label.choice { display: block; margin: 0 0 6px; font-weight: 400; }
  textarea, input[type=email] { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #c9c9d1; border-radius: 6px; font: inherit; }
  textarea { min-height: 120px; }
  button { background: #1a1a1a; color: #fff; border: 0; border-radius: 6px; padding: 12px 24px; font: inherit; font-weight: 600; cursor: pointer; }
  a { color: #1a1a1a; }
</style>
</head>
<body>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

// The public form. `profile` is the row (may be hidden); `error` is a message
// from a rejected POST; `values` echoes what the requester typed.
function renderDisputePage({ profile, error, values = {} }) {
  const hidden = hiddenReason(profile);
  const name = hidden ? `Profile #${profile.id}` : displayName(profile);
  const where = !hidden && [profile.firm_name, profile.city, profile.province].filter(Boolean).join(', ');
  const status = hidden === 'removed'
    ? '<p class="ok">This profile has already been removed and is not shown publicly.</p>'
    : hidden === 'dispute_pending'
      ? '<p class="ok">This profile is already hidden while an earlier request is reviewed. You can still send details below.</p>'
      : '';
  const choices = Object.entries(REASONS).map(([k, label]) =>
    `<label class="choice"><input type="radio" name="reason" value="${k}" required${values.reason === k ? ' checked' : ''}> ${esc(label)}</label>`
  ).join('\n      ');
  const form = hidden === 'removed' ? '' : `
  <form method="POST" action="${esc(disputeUrl(profile.id))}">
    <fieldset>
      <legend>What should we do?</legend>
      ${choices}
    </fieldset>
    <fieldset>
      <label class="block" for="details">Details (optional)</label>
      <textarea id="details" name="details" maxlength="${MAX_DETAILS}" placeholder="What is wrong, or what should it say instead?">${esc(values.details || '')}</textarea>
    </fieldset>
    <fieldset>
      <label class="block" for="email">Your email</label>
      <input id="email" name="email" type="email" required maxlength="255" value="${esc(values.email || '')}" placeholder="you@example.com">
      <p class="muted">We confirm the outcome to this address. It does not need to match any address on the profile.</p>
    </fieldset>
    <button type="submit">Send request</button>
  </form>`;
  return page(`Correct or remove this profile: ${name}`, `
  <h1>Correct or remove this profile</h1>
  <p><strong>${esc(name)}</strong>${where ? `<br><span class="muted">${esc(where)}</span>` : ''}</p>
  ${status}
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  ${hidden === 'removed' ? '' : `<p>Sending this form hides the profile from ${esc(PLATFORM.name)} right away. We confirm what we did within ${DECISION_WINDOW}.</p>`}
  ${form}
  <p class="muted">${esc(PLATFORM.name)} &middot; <a href="${esc(PLATFORM.frontendUrl)}/privacy-policy">Privacy policy</a></p>`);
}

function renderResultPage({ dispute, profile }) {
  return page('Request received', `
  <h1>Request received</h1>
  <p class="ok">Reference D-${dispute.id}. The profile is now hidden from public view.</p>
  <p>We will confirm what we did within ${DECISION_WINDOW} at <strong>${esc(dispute.requester_email)}</strong>.</p>
  <p class="muted">Profile #${profile.id} &middot; ${esc(REASONS[dispute.reason] || dispute.reason)}</p>
  <p class="muted"><a href="${esc(PLATFORM.frontendUrl)}">${esc(PLATFORM.name)}</a></p>`);
}

function renderErrorPage(title, text) {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p><p class="muted"><a href="${esc(PLATFORM.frontendUrl)}">${esc(PLATFORM.name)}</a></p>`);
}

function ackEmail({ dispute, profile }) {
  const name = displayName(profile);
  const subject = `We received your request about the ${PLATFORM.name} profile for ${name} (D-${dispute.id})`;
  const text = [
    `Hello,`,
    ``,
    `We received your request (${REASONS[dispute.reason] || dispute.reason}) about the ${PLATFORM.name} profile for ${name}.`,
    `The profile is hidden from public view as of now.`,
    ``,
    `We will confirm what we did within ${DECISION_WINDOW}. Reply to this email if you want to add anything.`,
    ``,
    `Reference: D-${dispute.id}`,
    `${PLATFORM.name}`,
  ].join('\n');
  const html = `<div style="font:15px/1.6 Arial,sans-serif;color:#1a1a1a;max-width:600px">
<p>Hello,</p>
<p>We received your request (<strong>${esc(REASONS[dispute.reason] || dispute.reason)}</strong>) about the ${esc(PLATFORM.name)} profile for <strong>${esc(name)}</strong>. The profile is hidden from public view as of now.</p>
<p>We will confirm what we did within ${DECISION_WINDOW}. Reply to this email if you want to add anything.</p>
<p style="color:#666;font-size:13px">Reference: D-${dispute.id}<br>${esc(PLATFORM.name)}</p>
</div>`;
  return { subject, text, html };
}

function alertEmail({ dispute, profile, suppressed, alreadyHidden }) {
  const name = displayName(profile);
  const subject = `[REMOVAL REQUEST] ${PLATFORM.code} D-${dispute.id}: ${REASONS[dispute.reason] || dispute.reason}: ${name} (profile ${profile.id})`;
  const lines = [
    `Platform: ${PLATFORM.name} (${PLATFORM.code})`,
    `Dispute: D-${dispute.id}, opened ${new Date(dispute.created_at).toISOString()}`,
    `Reason: ${REASONS[dispute.reason] || dispute.reason}`,
    `Profile: #${profile.id} ${name}${profile.firm_name ? `, ${profile.firm_name}` : ''}${profile.city || profile.province ? ` (${[profile.city, profile.province].filter(Boolean).join(', ')})` : ''}`,
    `Profile URL: ${profileUrl(profile.id)} (now 410)`,
    `Claim status: ${profile.claim_status || 'unclaimed'}`,
    `Requester: ${dispute.requester_email}${dispute.requester_ip ? ` from ${dispute.requester_ip}` : ''}`,
    `Suppressed: ${suppressed.length ? suppressed.map((s) => `${s.email}${s.inserted ? '' : ' (already listed)'}`).join(', ') : 'no address on the row'}`,
    alreadyHidden ? `Note: profile was already hidden (${alreadyHidden}) before this request.` : null,
    ``,
    `Details:`,
    dispute.details || '(none)',
    ``,
    `Resolve (decision due within ${DECISION_WINDOW}):`,
    `  POST ${PLATFORM.backendUrl}/api/admin/disputes/${dispute.id}/resolve  {"resolution":"removed"|"corrected"|"restored"}`,
    `Open list: GET ${PLATFORM.backendUrl}/api/admin/disputes`,
  ].filter((l) => l !== null);
  const text = lines.join('\n');
  const html = `<pre style="font:13px/1.5 Menlo,Consolas,monospace;white-space:pre-wrap">${esc(text)}</pre>`;
  return { subject, text, html };
}

module.exports = {
  PLATFORM, REASONS, RESOLUTIONS, SUPPRESSION_REASON, DECISION_WINDOW, MAX_DETAILS,
  VISIBLE_SQL, visibleSql, disputeUrl, profileUrl, displayName, hiddenReason, sendGone,
  isValidEmail, parseId, validateDisputeInput, ensureSchema, getProfile, rowEmails,
  openDispute, resolveDispute, listOpen,
  renderDisputePage, renderResultPage, renderErrorPage, ackEmail, alertEmail,
};
