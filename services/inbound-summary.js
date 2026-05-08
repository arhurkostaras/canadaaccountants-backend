// Twice-daily inbound activity summary email (Section 4.0 of campaign brief v1.7).
// Fires at 10:00 ET and 15:00 ET. Aggregates inbound counts across all four backends
// and sends a plain-text summary to arthur@negotiateandwin.com.
//
// Window logic:
//   10am summary covers the prior 19 hours (since 3pm yesterday)
//   3pm summary covers the prior 5 hours (since 10am same day)
// Together they cover 24h with no overlap.

const crypto = require('crypto');
const { Resend } = require('resend');

const PEER_BACKENDS = [
  { platform: 'law', urlEnv: 'LAW_BACKEND_URL' },
  { platform: 'inv', urlEnv: 'INV_BACKEND_URL' },
  { platform: 'cbe', urlEnv: 'CBE_BACKEND_URL' }
];

function _hmacSign(secret, ts, payload) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
}

function _windowStartFor(slot, now = new Date()) {
  // slot is '10am' or '3pm', resolved in America/New_York. We compute by stepping
  // back from `now` (which is when the cron fires, already in ET because of the
  // node-cron timezone option), so naive subtraction works:
  //   10am summary: subtract 19 hours
  //   3pm summary:  subtract 5 hours
  const hoursBack = slot === '10am' ? 19 : 5;
  return new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
}

async function _fetchPeerSummary(peer, sinceISO) {
  const url = process.env[peer.urlEnv];
  if (!url) return { platform: peer.platform, error: `${peer.urlEnv} not set` };
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) return { platform: peer.platform, error: 'INBOUND_WEBHOOK_SECRET not set' };
  const ts = Math.floor(Date.now() / 1000).toString();
  const path = '/api/admin/inbound-summary';
  const query = `since=${encodeURIComponent(sinceISO)}`;
  const canonical = `GET ${path}?${query}`;
  const sig = _hmacSign(secret, ts, canonical);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}${path}?${query}`, {
      headers: { 'X-Inbound-Timestamp': ts, 'X-Inbound-Signature': sig }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { platform: peer.platform, error: `${res.status}: ${text.slice(0, 120)}` };
    }
    return await res.json();
  } catch (err) {
    return { platform: peer.platform, error: err.message };
  }
}

async function _fetchLocalSummary(pool, sinceISO) {
  const r = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE classification_status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE classification_status = 'pending' AND received_at < NOW() - INTERVAL '4 hours')::int AS pending_sla_breach,
       COUNT(*) FILTER (WHERE classification_decision = 'breakdown')::int AS breakdown,
       COUNT(*) FILTER (WHERE classification_decision = 'unsubscribe')::int AS unsubscribe,
       COUNT(*) FILTER (WHERE classification_decision = 'touch7_in')::int AS touch7_in,
       COUNT(*) FILTER (WHERE classification_decision = 'touch7_out')::int AS touch7_out,
       COUNT(*) FILTER (WHERE classification_decision = 'manual')::int AS manual,
       COUNT(*) FILTER (WHERE classification_status = 'manual_review')::int AS manual_review,
       COUNT(*) FILTER (WHERE classification_status = 'suppressed')::int AS suppressed
     FROM inbound_messages
     WHERE received_at >= $1`,
    [sinceISO]
  );
  return { platform: 'acc', since: sinceISO, ...r.rows[0] };
}

async function _fetchPollerHealth(pool) {
  try {
    const r = await pool.query(`SELECT * FROM inbound_poll_status WHERE id = 1`);
    return r.rows[0] || null;
  } catch (e) {
    return null;
  }
}

function _formatPlainText({ slot, dateISO, sinceISO, perPlatform, pollHealth }) {
  const lines = [];
  const totalMessages = perPlatform.reduce((acc, p) => acc + (p.total || 0), 0);
  const totalPending = perPlatform.reduce((acc, p) => acc + (p.pending || 0), 0);
  const totalBreach = perPlatform.reduce((acc, p) => acc + (p.pending_sla_breach || 0), 0);
  const errors = perPlatform.filter(p => p.error);
  const consecutiveFailures = pollHealth?.consecutive_failures ?? null;

  let verdict = 'all clear';
  if (errors.length) verdict = `${errors.length} platform(s) errored — see below`;
  else if (totalBreach > 0) verdict = `${totalBreach} pending message(s) past 4h SLA`;
  else if (consecutiveFailures && consecutiveFailures > 0) verdict = `polling cron has ${consecutiveFailures} consecutive failure(s)`;

  lines.push(`Verdict: ${verdict}`);
  lines.push('');
  lines.push(`Slot: ${slot} ET on ${dateISO.slice(0, 10)}`);
  lines.push(`Window: since ${sinceISO} → ${dateISO}`);
  lines.push(`Total inbound: ${totalMessages}   |   Pending: ${totalPending}   |   SLA-breach: ${totalBreach}`);
  lines.push('');
  lines.push('Per-platform:');
  for (const p of perPlatform) {
    if (p.error) {
      lines.push(`  ${p.platform.toUpperCase()}: ERROR — ${p.error}`);
      continue;
    }
    lines.push(`  ${p.platform.toUpperCase()}: total=${p.total} pending=${p.pending} sla_breach=${p.pending_sla_breach} | breakdown=${p.breakdown} unsub=${p.unsubscribe} t7_in=${p.touch7_in} t7_out=${p.touch7_out} manual=${p.manual} review=${p.manual_review} suppress=${p.suppressed}`);
  }
  lines.push('');
  lines.push('Polling cron health (ACC-hosted):');
  if (pollHealth) {
    lines.push(`  last_poll_at: ${pollHealth.last_poll_at || 'never'}`);
    lines.push(`  last_poll_status: ${pollHealth.last_poll_status || 'n/a'}`);
    lines.push(`  last_poll_message_count: ${pollHealth.last_poll_message_count ?? 0}`);
    lines.push(`  consecutive_failures: ${pollHealth.consecutive_failures ?? 0}`);
    if (pollHealth.last_poll_error) lines.push(`  last_poll_error: ${pollHealth.last_poll_error}`);
  } else {
    lines.push('  (no status row)');
  }
  lines.push('');
  lines.push('--');
  lines.push('Inbound activity summary, generated by ACC. Section 4.0 of campaign brief v1.7.');
  return lines.join('\n');
}

async function sendSummary({ pool, slot }) {
  const now = new Date();
  const since = _windowStartFor(slot, now);
  const sinceISO = since.toISOString();
  const dateISO = now.toISOString();

  const [local, ...peers] = await Promise.all([
    _fetchLocalSummary(pool, sinceISO),
    ...PEER_BACKENDS.map(p => _fetchPeerSummary(p, sinceISO))
  ]);
  const perPlatform = [local, ...peers];
  const pollHealth = await _fetchPollerHealth(pool);
  const body = _formatPlainText({ slot, dateISO, sinceISO, perPlatform, pollHealth });

  const subject = `[INBOUND-SUMMARY] ${dateISO.slice(0, 10)} ${slot === '10am' ? '10AM' : '3PM'}`;
  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'noreply@canadaaccountants.app',
      to: 'arthur@negotiateandwin.com',
      subject,
      text: body
    });
    console.log(`[InboundSummary] sent ${slot} summary; total=${perPlatform.reduce((a, p) => a + (p.total || 0), 0)}`);
  } catch (err) {
    console.error('[InboundSummary] send failed:', err.message);
  }
}

module.exports = { sendSummary };
