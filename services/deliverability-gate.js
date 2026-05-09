// Deliverability gate (Section 4.5 of campaign brief v1.7).
//
// Evaluates platform-wide deliverability metrics every 30 minutes against the
// thresholds:
//   - spam complaint rate > 0.3%   → pause
//   - hard bounce rate > 2.0%      → pause
//   - open-rate drop > 30% touch-over-touch → pause (deferred until v2 sends produce per-touch data)
//
// On breach: writes to sequence_pause, sends alert email to Arthur. Manual
// unpause required (no auto-resume per Section 4.5). The v2 runner checks
// isPlatformPaused() before each send and skips if paused.

const { Resend } = require('resend');

const PLATFORM = 'acc';
const COMPLAINT_RATE_THRESHOLD = 0.003;  // 0.3%
const BOUNCE_RATE_THRESHOLD = 0.02;      // 2.0%
const MIN_VOLUME_FOR_GATE = 100;         // need at least 100 sends in window to evaluate

async function _computeWindowMetrics(pool, hours = 24) {
  const r = await pool.query(
    `SELECT
       COUNT(*)::int AS total_sent,
       COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
       COUNT(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounced,
       COUNT(*) FILTER (WHERE complained_at IS NOT NULL)::int AS complained,
       COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
       COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked
     FROM outreach_emails
     WHERE sent_at IS NOT NULL AND sent_at > NOW() - ($1::int || ' hours')::interval`,
    [hours]
  );
  const row = r.rows[0] || {};
  const sent = row.total_sent || 0;
  return {
    total_sent: sent,
    delivered: row.delivered || 0,
    bounced: row.bounced || 0,
    complained: row.complained || 0,
    opened: row.opened || 0,
    clicked: row.clicked || 0,
    complaint_rate: sent > 0 ? row.complained / sent : 0,
    bounce_rate: sent > 0 ? row.bounced / sent : 0,
    open_rate: sent > 0 ? row.opened / sent : 0,
    click_rate: sent > 0 ? row.clicked / sent : 0,
    window_hours: hours
  };
}

async function isPlatformPaused(pool) {
  const r = await pool.query(
    `SELECT 1 FROM sequence_pause
     WHERE platform = $1 AND unpaused_at IS NULL
     LIMIT 1`,
    [PLATFORM]
  );
  return r.rows.length > 0;
}

async function _alreadyPausedForReason(pool, reason) {
  const r = await pool.query(
    `SELECT 1 FROM sequence_pause
     WHERE platform = $1 AND unpaused_at IS NULL AND pause_reason = $2
     LIMIT 1`,
    [PLATFORM, reason]
  );
  return r.rows.length > 0;
}

async function _writePause(pool, reason, metrics) {
  const detail = `complaint=${(metrics.complaint_rate * 100).toFixed(2)}% bounce=${(metrics.bounce_rate * 100).toFixed(2)}% sent=${metrics.total_sent} window=${metrics.window_hours}h`;
  await pool.query(
    `INSERT INTO sequence_pause (platform, sequence, paused_at, pause_reason, paused_by)
     VALUES ($1, NULL, NOW(), $2, 'deliverability_gate')`,
    [PLATFORM, `${reason} | ${detail}`]
  );
}

async function _sendAlert(reason, metrics) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const fromEmail = process.env.FROM_EMAIL || 'noreply@canadaaccountants.app';
    await resend.emails.send({
      from: fromEmail,
      to: 'arthur@negotiateandwin.com',
      subject: `[DELIVERABILITY-PAUSE] ${PLATFORM.toUpperCase()} ${reason}`,
      text: `Deliverability gate triggered on ${PLATFORM.toUpperCase()}.

Reason: ${reason}

Metrics over last ${metrics.window_hours} hours:
  Sent: ${metrics.total_sent}
  Delivered: ${metrics.delivered}
  Bounced: ${metrics.bounced} (${(metrics.bounce_rate * 100).toFixed(2)}%)
  Complained: ${metrics.complained} (${(metrics.complaint_rate * 100).toFixed(2)}%)
  Opened: ${metrics.opened} (${(metrics.open_rate * 100).toFixed(2)}%)
  Clicked: ${metrics.clicked} (${(metrics.click_rate * 100).toFixed(2)}%)

Thresholds:
  Spam complaint rate > 0.3% → pause
  Hard bounce rate > 2.0% → pause

The v2 sequence runner will skip ${PLATFORM.toUpperCase()} sends until you manually
unpause via UPDATE sequence_pause SET unpaused_at = NOW(), unpaused_by = 'arthur'
WHERE platform = '${PLATFORM}' AND unpaused_at IS NULL;

Diagnose first. Section 4.5 of campaign brief v1.7.
`
    });
  } catch (err) {
    console.error('[DeliverabilityGate] alert send failed:', err.message);
  }
}

async function runOnce(pool) {
  const startedAt = new Date();
  let metrics;
  try {
    metrics = await _computeWindowMetrics(pool, 24);
  } catch (err) {
    console.error('[DeliverabilityGate] metrics query failed:', err.message);
    return { ok: false, error: err.message };
  }

  // Don't gate on tiny send volume — adds noise.
  if (metrics.total_sent < MIN_VOLUME_FOR_GATE) {
    return { ok: true, evaluated: false, reason: `volume ${metrics.total_sent} below ${MIN_VOLUME_FOR_GATE} threshold`, metrics };
  }

  const breaches = [];
  if (metrics.complaint_rate > COMPLAINT_RATE_THRESHOLD) breaches.push('complaint_rate_exceeded');
  if (metrics.bounce_rate > BOUNCE_RATE_THRESHOLD) breaches.push('bounce_rate_exceeded');

  for (const reason of breaches) {
    if (await _alreadyPausedForReason(pool, reason)) continue;
    await _writePause(pool, reason, metrics);
    await _sendAlert(reason, metrics);
    console.error(`[DeliverabilityGate] PAUSED ${PLATFORM} for ${reason}: complaint=${(metrics.complaint_rate * 100).toFixed(2)}% bounce=${(metrics.bounce_rate * 100).toFixed(2)}%`);
  }

  if (breaches.length === 0) {
    // Quiet success — only log when interesting
    console.log(`[DeliverabilityGate] ${startedAt.toISOString()} ${PLATFORM} OK: sent=${metrics.total_sent} complaint=${(metrics.complaint_rate * 100).toFixed(2)}% bounce=${(metrics.bounce_rate * 100).toFixed(2)}%`);
  }
  return { ok: true, evaluated: true, breaches, metrics };
}

module.exports = { runOnce, isPlatformPaused, _computeWindowMetrics };
