// Daily platforms digest. One email per day to Arthur at 07:00 America/Toronto
// replacing the nine-a-day pipeline monitor, the Monday founder-outreach digest
// and auto-send report, the twice-daily [INBOUND-SUMMARY] mails, and the hourly
// webhook-health alert mail. Removal/correction requests to support@ additionally
// fire an immediate [REMOVAL REQUEST] alert from the inbound poller at ingestion
// (three-business-day SLA).
//
// Structure of the mail:
//   1. Action required  (empty block reads "Nothing needs you today")
//   2. Numbers          (the pipeline monitor table, once)
//   3. Quiet            (one line per platform confirming crons ran)
// Monday editions append the founder-outreach candidate list, collapsed.
//
// buildDigest() is pure and unit-tested with fixtures; collectDigestData() does
// the I/O through injected dependencies so the same builder renders a real day.

const { sendEmail } = require('./email');
const inboundSummary = require('./inbound-summary');

const ADMIN_EMAIL = 'arthur@negotiateandwin.com';
const TZ = 'America/Toronto';

// Removal / correction language. Whole-word, case-insensitive. English plus the
// French "retrait"/"retirer" the platforms receive from Quebec professionals.
const REMOVAL_PATTERN = /\b(remove|removed|removal|retrait|retirer|misgender(?:ed|ing)?|inaccurate|inaccuracy|unauthori[sz]ed|cease)\b/i;

// support@ mailboxes on the four platform domains. The inbound poller stores
// mail to these addresses locally (never dispatched to a classifier, so no
// auto-reply is ever sent to the writer) and fires the removal alert.
const SUPPORT_ADDRESSES = {
  'support@canadaaccountants.app': 'acc',
  'support@canadalawyers.app': 'law',
  'support@canadainvesting.app': 'inv',
  'support@canadabusinessexits.app': 'cbe'
};

const PEER_FEEDS = [
  { platform: 'LAW', urlEnv: 'LAW_BACKEND_URL' },
  { platform: 'INV', urlEnv: 'INV_BACKEND_URL' }
];

function isRemovalRequest({ subject, body_text } = {}) {
  return REMOVAL_PATTERN.test(`${subject || ''}\n${body_text || ''}`);
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function torontoDate(now) {
  return now.toLocaleDateString('en-CA', { timeZone: TZ });
}

function torontoWeekday(now) {
  return now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
}

function torontoTime(value) {
  if (!value) return 'never';
  return new Date(value).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatAge(value, now) {
  if (!value) return 'unknown age';
  const ms = now.getTime() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function actionCount(actions) {
  return ['removalRequests', 'clientRequests', 'applicationsAwaitingPayment', 'inboundNeedingHuman', 'failures']
    .reduce((n, key) => n + ((actions && actions[key]) || []).length, 0);
}

function buildSubject(dateLabel, count) {
  return `Platforms daily — ${dateLabel} — ${count} ${count === 1 ? 'action' : 'actions'} required`;
}

const CARD = 'margin:0 0 12px;padding:12px 16px;border-radius:0 6px 6px 0;font-size:13px;';

function renderList(title, items, renderItem, color) {
  if (!items.length) return '';
  return `<div style="${CARD}background:${color.bg};border-left:4px solid ${color.edge};color:${color.text};">
    <strong>${esc(title)} (${items.length})</strong>
    <ul style="margin:6px 0 0;padding-left:18px;">${items.map(renderItem).join('')}</ul>
  </div>`;
}

const RED = { bg: '#fef2f2', edge: '#dc2626', text: '#991b1b' };
const AMBER = { bg: '#fffbeb', edge: '#d97706', text: '#92400e' };
const BLUE = { bg: '#eff6ff', edge: '#2563eb', text: '#1e40af' };
const GREEN = { bg: '#f0fdf4', edge: '#059669', text: '#166534' };

function renderActions(actions, now) {
  const a = {
    removalRequests: [], clientRequests: [], applicationsAwaitingPayment: [], inboundNeedingHuman: [], failures: [],
    ...(actions || {})
  };
  const count = actionCount(a);
  if (count === 0) {
    return `<div style="${CARD}background:${GREEN.bg};border-left:4px solid ${GREEN.edge};color:${GREEN.text};font-size:14px;">Nothing needs you today.</div>`;
  }
  return [
    renderList('Removal / correction requests (3-business-day SLA)', a.removalRequests, r =>
      `<li><strong>${esc(r.platform)}</strong> ${esc(r.fromEmail)} to ${esc(r.toEmail)}: "${esc(r.subject || '(no subject)')}" (${formatAge(r.receivedAt, now)})</li>`, RED),
    renderList('Real failures', a.failures, f =>
      `<li><strong>${esc(f.platform)}</strong>: ${esc(f.message)}</li>`, RED),
    renderList('New client requests (24h)', a.clientRequests, c =>
      `<li><strong>${esc(c.platform)}</strong> ${esc(c.name || '(no name)')}, ${esc(c.province || 'province unknown')}, ${esc(c.service || 'service unspecified')} (${formatAge(c.createdAt, now)}${c.source ? ', via ' + esc(c.source) : ''})</li>`, AMBER),
    renderList('Professional applications awaiting payment', a.applicationsAwaitingPayment, p =>
      `<li><strong>${esc(p.platform)}</strong> ${esc(p.name)}${p.firm ? ', ' + esc(p.firm) : ''}${p.province ? ', ' + esc(p.province) : ''}${p.tier ? ' (' + esc(p.tier) + ')' : ''}: ${esc(p.email)} (submitted ${formatAge(p.submittedAt, now)})</li>`, AMBER),
    renderList('Inbound replies needing a human', a.inboundNeedingHuman, m =>
      `<li><strong>${esc(m.platform)}</strong> ${esc(m.fromEmail)}: "${esc(m.subject || '(no subject)')}" ${m.reason ? '[' + esc(m.reason) + '] ' : ''}(${formatAge(m.receivedAt, now)})</li>`, BLUE)
  ].join('');
}

function renderQuiet(quiet) {
  const lines = (quiet || []).map(q =>
    `<li style="color:${q.ok ? '#166534' : '#92400e'};"><strong>${esc(q.platform)}</strong>: ${esc(q.line)}</li>`).join('');
  return `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;">${lines || '<li>No platform status collected.</li>'}</ul>`;
}

function renderFounder(founder) {
  if (!founder) return '';
  return `<details style="margin:16px 0;">
    <summary style="cursor:pointer;font-weight:600;color:#1e3a8a;">Monday: founder-outreach candidates (${founder.total})${founder.autoSendPaused ? ' · auto-send paused' : ''}</summary>
    <div style="margin-top:8px;">${founder.html || ''}</div>
  </details>`;
}

function buildDigest(data) {
  const now = data.now instanceof Date ? data.now : new Date(data.now || Date.now());
  const dateLabel = data.dateLabel || torontoDate(now);
  const actions = data.actions || {};
  const count = actionCount(actions);
  const numbers = data.numbers || {};
  const notesHtml = (numbers.notes || []).length
    ? `<div style="${CARD}background:#f8fafc;border-left:4px solid #94a3b8;color:#475569;"><strong>Notes</strong><ul style="margin:6px 0 0;padding-left:18px;">${numbers.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`
    : '';

  const html = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#0f172a;">
    <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;font-size:18px;">Platforms daily — ${esc(dateLabel)}</h2>
      <p style="margin:4px 0 0;opacity:0.85;font-size:13px;">${count} ${count === 1 ? 'action' : 'actions'} required · ACC / LAW / INV / CBE</p>
    </div>
    <div style="padding:20px 24px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
      <h3 style="margin:0 0 10px;font-size:15px;color:#0f172a;">1. Action required</h3>
      ${renderActions(actions, now)}
      <h3 style="margin:20px 0 10px;font-size:15px;color:#0f172a;">2. Numbers</h3>
      ${numbers.html || '<p style="font-size:13px;color:#64748b;">Pipeline numbers unavailable.</p>'}
      ${notesHtml}
      ${renderFounder(data.founder)}
      <h3 style="margin:20px 0 6px;font-size:15px;color:#0f172a;">3. Quiet</h3>
      ${renderQuiet(data.quiet)}
      <p style="margin:16px 0 0;font-size:11px;color:#94a3b8;">Auto-generated by the ACC daily digest at 07:00 ${TZ}. Removal requests also alert immediately with the [REMOVAL REQUEST] prefix.</p>
    </div>
  </div>`;

  const text = buildText({ dateLabel, count, actions, numbers, quiet: data.quiet, founder: data.founder, now });
  return { subject: buildSubject(dateLabel, count), html, text, actionCount: count };
}

function buildText({ dateLabel, count, actions, numbers, quiet, founder, now }) {
  const lines = [`Platforms daily ${dateLabel}: ${count} action(s) required`, '', '1. ACTION REQUIRED'];
  if (count === 0) lines.push('Nothing needs you today.');
  const push = (title, items, fmt) => {
    if (!items || !items.length) return;
    lines.push(`${title} (${items.length})`);
    items.forEach(i => lines.push(`  - ${fmt(i)}`));
  };
  push('Removal / correction requests', actions.removalRequests, r => `${r.platform} ${r.fromEmail} to ${r.toEmail}: ${r.subject || '(no subject)'} (${formatAge(r.receivedAt, now)})`);
  push('Real failures', actions.failures, f => `${f.platform}: ${f.message}`);
  push('New client requests (24h)', actions.clientRequests, c => `${c.platform} ${c.name || '(no name)'}, ${c.province || 'province unknown'}, ${c.service || 'service unspecified'} (${formatAge(c.createdAt, now)})`);
  push('Applications awaiting payment', actions.applicationsAwaitingPayment, p => `${p.platform} ${p.name} ${p.email} (submitted ${formatAge(p.submittedAt, now)})`);
  push('Inbound needing a human', actions.inboundNeedingHuman, m => `${m.platform} ${m.fromEmail}: ${m.subject || '(no subject)'} (${formatAge(m.receivedAt, now)})`);
  lines.push('', '2. NUMBERS');
  lines.push(numbers.text || (numbers.html ? numbers.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : 'unavailable'));
  (numbers.notes || []).forEach(n => lines.push(`  note: ${n}`));
  if (founder) lines.push('', `Monday: ${founder.total} founder-outreach candidates (see HTML)`);
  lines.push('', '3. QUIET');
  (quiet || []).forEach(q => lines.push(`  ${q.platform}: ${q.line}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Collection (I/O). Every source is isolated: a failing query lands in the
// failures list of the Action block instead of aborting the digest.
// ---------------------------------------------------------------------------

function realAddressFilter(col) {
  return `(${col} IS NULL OR (${col} NOT ILIKE 'arthur@%' AND ${col} NOT ILIKE 'arthur+%' AND ${col} NOT ILIKE '%negotiateandwin%' AND ${col} NOT ILIKE '%akrosfinancial%' AND ${col} NOT ILIKE '%@test.%' AND ${col} NOT ILIKE '%@testcpa%' AND ${col} NOT ILIKE '%@example.%'))`;
}

async function safeRows(pool, label, sql, params, failures) {
  try {
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (err) {
    console.error(`[DailyDigest] ${label} query failed:`, err.message);
    failures.push({ platform: 'ACC', message: `${label} query failed: ${err.message}` });
    return [];
  }
}

// ACC's own feed. The same shape is served at GET /api/daily-digest/feed so the
// LAW/INV ports return it to this collector.
async function collectLocalFeed(pool, sinceISO, { now = new Date() } = {}) {
  const failures = [];
  const clientRequests = [];

  const friction = await safeRows(pool, 'friction requests',
    `SELECT contact_info->>'name' AS name,
            COALESCE(contact_info->>'province', contact_info->>'location', contact_info->>'city') AS province,
            pain_point AS service, created_at
     FROM sme_friction_requests
     WHERE created_at >= $1 AND ${realAddressFilter("contact_info->>'email'")}
     ORDER BY created_at DESC LIMIT 25`, [sinceISO], failures);
  friction.forEach(r => clientRequests.push({ platform: 'ACC', name: r.name, province: r.province, service: r.service, createdAt: r.created_at, source: 'friction form' }));

  const searches = await safeRows(pool, 'client search requests',
    `SELECT name, province, specialization AS service, created_at
     FROM client_search_requests
     WHERE created_at >= $1 AND ${realAddressFilter('email')}
     ORDER BY created_at DESC LIMIT 25`, [sinceISO], failures);
  searches.forEach(r => clientRequests.push({ platform: 'ACC', name: r.name, province: r.province, service: r.service, createdAt: r.created_at, source: 'search' }));

  const profiles = await safeRows(pool, 'client profiles',
    `SELECT contact_name AS name, province, service_type AS service, created_at
     FROM client_profiles
     WHERE created_at >= $1 AND ${realAddressFilter('contact_email')}
     ORDER BY created_at DESC LIMIT 25`, [sinceISO], failures);
  profiles.forEach(r => clientRequests.push({ platform: 'ACC', name: r.name, province: r.province, service: r.service, createdAt: r.created_at, source: 'client profile' }));

  const contacts = await safeRows(pool, 'contact submissions',
    `SELECT name, NULL::text AS province, COALESCE(subject, source_page) AS service, created_at
     FROM contact_submissions
     WHERE created_at >= $1 AND ${realAddressFilter('email')}
     ORDER BY created_at DESC LIMIT 25`, [sinceISO], failures);
  contacts.forEach(r => clientRequests.push({ platform: 'ACC', name: r.name, province: r.province, service: r.service, createdAt: r.created_at, source: 'contact form' }));
  clientRequests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // status='approved' means accepted and redirected to Stripe; the webhook flips
  // it to 'paid'. Thirty-day window so stale applications age out of the digest.
  const apps = await safeRows(pool, 'applications awaiting payment',
    `SELECT id, full_name, email, firm_name, province, pricing_tier, submitted_at
     FROM cpa_applications
     WHERE status = 'approved' AND submitted_at >= NOW() - INTERVAL '30 days'
     ORDER BY submitted_at DESC LIMIT 20`, [], failures);
  const applicationsAwaitingPayment = apps.map(r => ({
    platform: 'ACC', name: r.full_name, email: r.email, firm: r.firm_name, province: r.province, tier: r.pricing_tier, submittedAt: r.submitted_at
  }));

  // Inbound mail that needs eyes: manual_review rows, Touch 7 acceptances, and
  // everything addressed to support@ (stored by the poller, never auto-replied).
  const inbound = await safeRows(pool, 'inbound messages',
    `SELECT id, platform, from_email, to_email, subject, LEFT(body_text, 2000) AS body_text, received_at,
            classification_status, classification_decision
     FROM inbound_messages
     WHERE received_at >= $1
       AND (classification_status = 'manual_review' OR classification_decision = 'touch7_in' OR to_email LIKE 'support@%')
     ORDER BY received_at DESC LIMIT 50`, [sinceISO], failures);
  const removalRequests = [];
  const inboundNeedingHuman = [];
  for (const m of inbound) {
    const platform = (m.platform || 'acc').toUpperCase();
    if (isRemovalRequest(m)) {
      removalRequests.push({ platform, fromEmail: m.from_email, toEmail: m.to_email, subject: m.subject, receivedAt: m.received_at });
    } else {
      const reason = m.classification_decision === 'touch7_in' ? 'Touch 7 acceptance' : (m.to_email || '').startsWith('support@') ? 'support@' : 'manual review';
      inboundNeedingHuman.push({ platform, fromEmail: m.from_email, subject: m.subject, receivedAt: m.received_at, reason });
    }
  }

  const pollHealth = await inboundSummary._fetchPollerHealth(pool);
  const classified = await safeRows(pool, 'classifier activity',
    `SELECT COUNT(*)::int AS n FROM inbound_messages WHERE processed_at >= $1`, [sinceISO], failures);
  let gatePaused = null;
  try {
    gatePaused = await require('./deliverability-gate').isPlatformPaused(pool);
  } catch (err) {
    console.error('[DailyDigest] deliverability gate read failed:', err.message);
    failures.push({ platform: 'ACC', message: `deliverability gate read failed: ${err.message}` });
  }

  return {
    platform: 'ACC',
    since: sinceISO,
    generated_at: now.toISOString(),
    client_requests: clientRequests,
    applications_awaiting_payment: applicationsAwaitingPayment,
    removal_requests: removalRequests,
    inbound_needing_human: inboundNeedingHuman,
    crons: {
      poller_last_at: pollHealth?.last_poll_at || null,
      poller_status: pollHealth?.last_poll_status || null,
      poller_consecutive_failures: pollHealth?.consecutive_failures ?? null,
      classified_24h: classified[0]?.n ?? null,
      gate_paused: gatePaused
    },
    failures
  };
}

async function fetchPeerFeed(peer, sinceISO) {
  const url = process.env[peer.urlEnv];
  if (!url) return { platform: peer.platform, error: `${peer.urlEnv} not set` };
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) return { platform: peer.platform, error: 'INBOUND_WEBHOOK_SECRET not set' };
  const crypto = require('crypto');
  const ts = Math.floor(Date.now() / 1000).toString();
  const path = '/api/daily-digest/feed';
  const query = `since=${encodeURIComponent(sinceISO)}`;
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.GET ${path}?${query}`).digest('hex');
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}${path}?${query}`, {
      headers: { 'X-Inbound-Timestamp': ts, 'X-Inbound-Signature': sig },
      signal: AbortSignal.timeout(10000)
    });
    if (res.status === 404) return { platform: peer.platform, notDeployed: true };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { platform: peer.platform, error: `${res.status}: ${text.slice(0, 120)}` };
    }
    return await res.json();
  } catch (err) {
    return { platform: peer.platform, error: err.message };
  }
}

function mergePeerFeed(feed, actions, quietParts) {
  const p = feed.platform;
  if (feed.notDeployed) {
    quietParts.push('digest feed not deployed yet (sibling port pending)');
    return;
  }
  if (feed.error) {
    actions.failures.push({ platform: p, message: `digest feed unreachable: ${feed.error}` });
    return;
  }
  (feed.client_requests || []).forEach(c => actions.clientRequests.push({ platform: p, name: c.name, province: c.province, service: c.service, createdAt: c.createdAt || c.created_at, source: c.source }));
  (feed.applications_awaiting_payment || []).forEach(a => actions.applicationsAwaitingPayment.push({ platform: p, ...a }));
  (feed.removal_requests || []).forEach(r => actions.removalRequests.push({ platform: p, ...r }));
  (feed.inbound_needing_human || []).forEach(m => actions.inboundNeedingHuman.push({ platform: p, ...m }));
  (feed.failures || []).forEach(f => actions.failures.push({ platform: p, message: f.message || String(f) }));
  const c = feed.crons || {};
  if (c.poller_last_at) quietParts.push(`poller ${torontoTime(c.poller_last_at)}`);
  if (c.classified_24h != null) quietParts.push(`classifier ${c.classified_24h} processed`);
  if (c.gate_paused === true) actions.failures.push({ platform: p, message: 'deliverability gate has the platform PAUSED' });
  mergeLeadLoop(p, feed.lead_loop, actions, quietParts);
  quietParts.push('digest feed ok');
}

// Lead-loop line for a platform that runs the lead notification loop (LAW from
// 2026-09-07). A bounce on a lead notification is an action the same day, not
// a quiet line: the recipient pool is scraped registry data and a bounce means
// an address that should leave the pool before the next request lands.
function leadLoopLine(l) {
  const n = (v) => (v == null ? '?' : v);
  return `lead loop${l.enabled ? '' : ' (flag off)'}: ${n(l.matches)} matches, ${n(l.lawyers_emailed)} lawyers emailed (${n(l.distinct_lawyers)} distinct), ` +
    `${n(l.opened)} opened, ${n(l.claimed)} claimed, ${n(l.responded)} responded, ${n(l.bounces)} bounces, ${n(l.unsubscribes)} unsubscribes, ` +
    `gate ${n(l.min_scraped_score)}: ${n(l.leads_under_three)} lead(s) under three recipients`;
}

function mergeLeadLoop(platform, leadLoop, actions, quietParts) {
  if (!leadLoop) return;
  quietParts.push(leadLoopLine(leadLoop));
  if (leadLoop.bounces > 0) {
    actions.failures.push({ platform, message: `${leadLoop.bounces} bounce(s) on lead notifications in the last 24h; remove the address(es) from the pool today (outreach_unsubscribes reason bounce, lawyer_email in lead_notifications)` });
  }
}

// deps: { pool, now, collectPipeline, webhookCheck, founderDigest, breakerState,
//         fetchPeerFeed?, fetchPeerSummary? }  (the last two are injectable for tests)
async function collectDigestData(deps) {
  const now = deps.now || new Date();
  const peerFeed = deps.fetchPeerFeed || fetchPeerFeed;
  const peerSummary = deps.fetchPeerSummary || inboundSummary._fetchPeerSummary;
  const sinceISO = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const actions = { removalRequests: [], clientRequests: [], applicationsAwaitingPayment: [], inboundNeedingHuman: [], failures: [] };
  const quietByPlatform = { ACC: [], LAW: [], INV: [], CBE: [] };
  const healthy = { ACC: true, LAW: true, INV: true, CBE: true };
  const flag = (platform, message) => { actions.failures.push({ platform, message }); healthy[platform] = false; };

  // 1. ACC local feed
  const local = await collectLocalFeed(deps.pool, sinceISO, { now });
  actions.clientRequests.push(...local.client_requests);
  actions.applicationsAwaitingPayment.push(...local.applications_awaiting_payment);
  actions.removalRequests.push(...local.removal_requests);
  actions.inboundNeedingHuman.push(...local.inbound_needing_human);
  local.failures.forEach(f => flag('ACC', f.message));
  const c = local.crons;
  if (c.poller_last_at) {
    const ageMin = Math.round((now - new Date(c.poller_last_at)) / 60000);
    quietByPlatform.ACC.push(`poller ran ${ageMin}m ago (${c.poller_status || 'n/a'})`);
    if (ageMin > 30) flag('ACC', `inbound poller last ran ${ageMin}m ago (expected every 5m)`);
  } else {
    quietByPlatform.ACC.push('poller: no status row');
  }
  if (c.poller_consecutive_failures > 0) flag('ACC', `inbound poller has ${c.poller_consecutive_failures} consecutive failure(s)`);
  if (c.classified_24h != null) quietByPlatform.ACC.push(`classifier processed ${c.classified_24h} in 24h`);
  if (c.gate_paused === true) flag('ACC', 'deliverability gate has the platform PAUSED (open sequence_pause row)');
  else if (c.gate_paused === false) quietByPlatform.ACC.push('deliverability gate clear');

  // 2. Peer feeds (LAW, INV)
  const feedOk = {};
  for (const peer of PEER_FEEDS) {
    const feed = await peerFeed(peer, sinceISO);
    const before = actions.failures.length;
    mergePeerFeed({ ...feed, platform: peer.platform }, actions, quietByPlatform[peer.platform]);
    if (actions.failures.length > before) healthy[peer.platform] = false;
    feedOk[peer.platform] = !feed.error && !feed.notDeployed;
  }

  // 3. Inbound counts from the peers' /api/inbound-summary (existing HMAC contract)
  const peerSummaries = await Promise.all(inboundSummary.PEER_BACKENDS.map(p => peerSummary(p, sinceISO)));
  for (const s of peerSummaries) {
    const platform = (s.platform || '').toUpperCase();
    if (!quietByPlatform[platform]) continue;
    if (s.error) {
      quietByPlatform[platform].push(`inbound summary unavailable (${s.error})`);
      continue;
    }
    (s.pending_breakdowns || []).forEach(b => actions.inboundNeedingHuman.push({
      platform, fromEmail: b.recipient_email, subject: 'breakdown reply awaiting approval', receivedAt: b.replied_at, reason: 'breakdown pending approval'
    }));
    if (s.manual_review > 0) actions.inboundNeedingHuman.push({
      platform, fromEmail: `${s.manual_review} message(s)`, subject: 'in manual_review on that backend', receivedAt: sinceISO, reason: 'manual review'
    });
    quietByPlatform[platform].push(`inbound ${s.total || 0} in 24h`);
  }

  // 4. Pipeline numbers (the former monitor)
  let numbers = { html: '', notes: [] };
  if (deps.collectPipeline) {
    try {
      const p = await deps.collectPipeline();
      numbers = { html: p.html, notes: p.notes || [] };
      (p.failures || []).forEach(f => flag(f.platform, f.message));
      (p.backends || []).forEach(b => {
        if (!quietByPlatform[b.name]) return;
        quietByPlatform[b.name].push(b.ok ? `health ok (sent ${b.sent}, queued ${b.queued}, active ${b.active})` : 'health endpoint unreachable');
      });
      // Fallback only while the LAW digest feed is not serving: once it is, the
      // same friction requests arrive with name and province and this would
      // list them twice.
      if (!feedOk.LAW) {
        (p.lawRequests || []).forEach(r => actions.clientRequests.push({
          platform: 'LAW', name: null, province: null, service: r.pain_point, createdAt: r.created_at, source: 'friction form (demand-attribution)'
        }));
      }
    } catch (err) {
      console.error('[DailyDigest] pipeline collection failed:', err.message);
      flag('ACC', `pipeline monitor collection failed: ${err.message}`);
    }
  }

  // 5. Webhook health (the former hourly alert mail)
  if (deps.webhookCheck) {
    try {
      const w = await deps.webhookCheck();
      for (const f of (w.failures || [])) {
        const platform = (f.split(':')[0] || '').trim();
        flag(quietByPlatform[platform] ? platform : 'ACC', `webhook health: ${f}`);
      }
      if (!(w.failures || []).length) Object.keys(quietByPlatform).forEach(k => quietByPlatform[k].push('webhook health ok'));
    } catch (err) {
      console.error('[DailyDigest] webhook check failed:', err.message);
      flag('ACC', `webhook health probe failed: ${err.message}`);
    }
  }

  // 6. In-process breakers
  if (deps.breakerState) {
    const b = deps.breakerState();
    if (b && b.zbConsecutiveErrors >= 3) flag('ACC', `ZeroBounce circuit breaker open (${b.zbConsecutiveErrors} consecutive errors)`);
  }

  // 7. Monday: founder-outreach candidates, collapsed
  let founder = null;
  if (deps.founderDigest && torontoWeekday(now) === 'Mon') {
    try {
      const f = await deps.founderDigest();
      founder = { html: f.html, total: f.total, autoSendPaused: process.env.FOUNDER_AUTO_SEND_PAUSED === 'true' };
    } catch (err) {
      console.error('[DailyDigest] founder digest failed:', err.message);
      flag('ACC', `founder digest build failed: ${err.message}`);
    }
  }

  // Newest client request first regardless of which platform supplied it
  actions.clientRequests.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const quiet = Object.keys(quietByPlatform).map(platform => ({
    platform,
    ok: healthy[platform],
    line: quietByPlatform[platform].length ? quietByPlatform[platform].join(' · ') : 'no signals collected'
  }));

  return { now, dateLabel: torontoDate(now), actions, numbers, quiet, founder };
}

async function sendDailyDigest(deps) {
  const data = await collectDigestData(deps);
  const digest = buildDigest(data);
  const send = deps.sendEmail || sendEmail;
  const result = await send({
    to: ADMIN_EMAIL,
    subject: digest.subject,
    html: digest.html,
    text: digest.text,
    from: process.env.FROM_EMAIL || 'noreply@canadaaccountants.app'
  });
  if (result && result.success === false) {
    console.error('[DailyDigest] send failed:', result.reason, result.error || '');
  } else {
    console.log(`[DailyDigest] sent: ${digest.subject}`);
  }
  return { ...digest, sendResult: result };
}

// Immediate alert for a removal/correction request, fired by the poller when a
// support@ message is stored. Three-business-day SLA.
function buildRemovalAlert(message, now = new Date()) {
  const platform = (message.platform || SUPPORT_ADDRESSES[(message.to_email || '').toLowerCase()] || 'acc').toUpperCase();
  const subjectLine = message.subject || '(no subject)';
  const body = (message.body_text || '').trim().slice(0, 1500);
  return {
    subject: `[REMOVAL REQUEST] ${platform}: ${subjectLine}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;color:#0f172a;">
      <div style="${CARD}background:${RED.bg};border-left:4px solid ${RED.edge};color:${RED.text};font-size:14px;">
        <strong>Removal / correction request on ${esc(platform)}</strong> — three-business-day SLA, due by ${esc(businessDaysFrom(now, 3))}.
      </div>
      <p style="font-size:13px;"><strong>From:</strong> ${esc(message.from_email)}<br>
      <strong>To:</strong> ${esc(message.to_email)}<br>
      <strong>Received:</strong> ${esc(torontoTime(message.received_at))}<br>
      <strong>Subject:</strong> ${esc(subjectLine)}</p>
      <pre style="white-space:pre-wrap;font-size:12px;background:#f8fafc;padding:12px;border-radius:6px;">${esc(body)}</pre>
      <p style="font-size:11px;color:#94a3b8;">Stored in inbound_messages (manual_review, no auto-reply sent). Also listed in tomorrow's daily digest.</p>
    </div>`,
    text: `Removal / correction request on ${platform} (3-business-day SLA, due ${businessDaysFrom(now, 3)})\nFrom: ${message.from_email}\nTo: ${message.to_email}\nReceived: ${torontoTime(message.received_at)}\nSubject: ${subjectLine}\n\n${body}`
  };
}

function businessDaysFrom(start, days) {
  const d = new Date(start.getTime());
  let remaining = days;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
    if (dow !== 'Sat' && dow !== 'Sun') remaining--;
  }
  return torontoDate(d);
}

async function sendRemovalAlert(message, { sendEmail: send = sendEmail, now = new Date() } = {}) {
  const alert = buildRemovalAlert(message, now);
  const result = await send({
    to: ADMIN_EMAIL,
    subject: alert.subject,
    html: alert.html,
    text: alert.text,
    from: process.env.FROM_EMAIL || 'noreply@canadaaccountants.app'
  });
  if (result && result.success === false) {
    console.error('[DailyDigest] removal alert send failed:', result.reason, result.error || '');
  } else {
    console.log(`[DailyDigest] removal alert sent: ${alert.subject}`);
  }
  return result;
}

module.exports = {
  REMOVAL_PATTERN,
  SUPPORT_ADDRESSES,
  isRemovalRequest,
  formatAge,
  buildSubject,
  buildDigest,
  buildRemovalAlert,
  businessDaysFrom,
  collectLocalFeed,
  collectDigestData,
  sendDailyDigest,
  sendRemovalAlert
};
