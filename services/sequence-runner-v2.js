// v2 supply-side sequence runner (Section 4.4 of campaign brief v1.7).
//
// Drives the 7-touch (or 6-touch for CBE) cold outreach sequence. Reads
// templates from email_template (Section 4.7), applies merge tags via
// founding-cohort.js (Section 4.3), enforces stop conditions (Section 2.2),
// advances state per recipient.
//
// LAW: 7 touches at Day 0, 7, 14, 21, 28, 42, 56 (skip 35 per Section 2.1).
//
// Not yet wired to a cron — Touch 1 launch waits on:
//   - templates loaded into email_template
//   - CASL footer wired (Section 4.9)
//   - deliverability gate (Section 4.5)
//   - source verification (Section 4.6) sign-off
// Once those land, wire `runOnce` on a 5-min cron.

const { Resend } = require('resend');
const foundingCohort = require('./founding-cohort');
const unsubscribeToken = require('./unsubscribe-token');
const profileTags = require('./profile-tags');

const PLATFORM = 'acc';
const SEQUENCE_NAME = 'supply_v2_7touch';
const RECIPIENT_TABLE = 'scraped_cpas';
const RECIPIENT_EMAIL_COLS = ['enriched_email', 'email'];
const UNSUBSCRIBE_TABLE = 'outreach_unsubscribes';

// Section 2.1: Day offsets 0, 7, 14, 21, 28, 42, 56 (skip 35).
// step_number is 1-indexed touch number (Touch 1 = step 1).
const SEQUENCE_STEPS = [
  { step: 1, delay_days: 0,  touch_label: 'Touch 1' },
  { step: 2, delay_days: 7,  touch_label: 'Touch 2' },
  { step: 3, delay_days: 14, touch_label: 'Touch 3' },
  { step: 4, delay_days: 21, touch_label: 'Touch 4' },
  { step: 5, delay_days: 28, touch_label: 'Touch 5' },
  { step: 6, delay_days: 42, touch_label: 'Touch 6' },
  { step: 7, delay_days: 56, touch_label: 'Touch 7' }
];

// Section 8.1 launch checklist gates — runner refuses to send while any are open.
function _isReadyToLaunch() {
  // Defaults to false until the launch checklist sets V2_RUNNER_LAUNCH_READY=true.
  return process.env.V2_RUNNER_LAUNCH_READY === 'true';
}

function _coalesceEmailExpr(alias) {
  return `COALESCE(${RECIPIENT_EMAIL_COLS.map(c => `${alias}.${c}`).join(', ')})`;
}

// Stop conditions per Section 2.2: unsubscribed, bounced, paid, replied,
// claimed, complained. Returns the exit_reason if any is true, else null.
async function _checkStopConditions(pool, recipientEmail, recipientId) {
  const lower = (recipientEmail || '').toLowerCase().trim();
  if (!lower) return 'no_email';

  // Unsubscribed
  const u = await pool.query(`SELECT 1 FROM ${UNSUBSCRIBE_TABLE} WHERE LOWER(email) = $1 LIMIT 1`, [lower]);
  if (u.rows.length > 0) return 'unsubscribed';

  // Replied (any inbound message from this address)
  const r = await pool.query(`SELECT 1 FROM inbound_messages WHERE LOWER(from_email) = $1 LIMIT 1`, [lower]);
  if (r.rows.length > 0) return 'replied';

  // Hard bounce or complaint flagged on the recipient's profile via outreach_emails
  // (existing send-tracking table).
  try {
    const b = await pool.query(
      `SELECT 1 FROM outreach_emails
       WHERE LOWER(recipient_email) = $1 AND status IN ('bounced', 'complained')
       LIMIT 1`,
      [lower]
    );
    if (b.rows.length > 0) return 'bounced_or_complained';
  } catch (_) { /* outreach_emails may not exist; non-fatal */ }

  // Claimed — check scraped_lawyers.claim_status
  try {
    const c = await pool.query(
      `SELECT claim_status FROM ${RECIPIENT_TABLE} WHERE id = $1 LIMIT 1`,
      [recipientId]
    );
    if (c.rows[0]?.claim_status === 'claimed') return 'claimed';
  } catch (_) { /* claim_status may not exist on all backends; non-fatal */ }

  return null;
}

// Touch 2 + Touch 5 conditional ship logic (Section 4.4). Returns 'default' or 'lite'.
async function _resolveVariant(pool, stepNumber) {
  if (stepNumber === 2) {
    // LAW: ships full Touch 2 if friction_matches has ≥3 entries in past 7 days
    try {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM friction_matches WHERE created_at > NOW() - INTERVAL '7 days'`
      );
      return (r.rows[0]?.n || 0) >= 3 ? 'default' : 'lite';
    } catch (_) {
      return 'lite'; // friction_matches missing — fall through to Lite
    }
  }
  if (stepNumber === 5) {
    // Touch 5 ships only if founding_cohort_joiners ≥3 in past 7 days AND friction_matches ≥1 in past 7 days
    try {
      const j = await pool.query(
        `SELECT COUNT(*)::int AS n FROM founding_cohort_joiners
         WHERE platform = $1 AND joined_at > NOW() - INTERVAL '7 days'`,
        [PLATFORM]
      );
      const f = await pool.query(
        `SELECT COUNT(*)::int AS n FROM friction_matches WHERE created_at > NOW() - INTERVAL '7 days'`
      );
      const okJ = (j.rows[0]?.n || 0) >= 3;
      const okF = (f.rows[0]?.n || 0) >= 1;
      return (okJ && okF) ? 'default' : 'lite';
    } catch (_) {
      return 'lite';
    }
  }
  return 'default';
}

async function _loadTemplate(pool, stepNumber, variant) {
  const r = await pool.query(
    `SELECT subject_a, subject_b, body_text, body_html
     FROM email_template
     WHERE platform = $1 AND sequence = $2 AND touch_number = $3 AND variant = $4
     LIMIT 1`,
    [PLATFORM, SEQUENCE_NAME, stepNumber, variant]
  );
  return r.rows[0] || null;
}

function _appendCASLFooter(text, html) {
  const addr = process.env.CASL_PHYSICAL_ADDRESS || '1012-728 Yates Street, Victoria, BC, Canada';
  const footer = `\n\n---\nYou are receiving this because your business contact information is publicly listed in CPA Canada provincial directories. To unsubscribe: reply with the word "unsubscribe" and I will remove you within 10 business days. Sender: Arthur Kostaras, ${addr}.`;
  const htmlFooter = `<div style="margin-top:24px;padding:16px;background:#f5f5f5;color:#777;font-size:11px;line-height:1.5;font-family:Arial,sans-serif;">You are receiving this because your business contact information is publicly listed in CPA Canada provincial directories. To unsubscribe: reply with the word "unsubscribe" and I will remove you within 10 business days. Sender: Arthur Kostaras, ${addr}.</div>`;
  return {
    text: (text || '') + footer,
    html: (html || '') + htmlFooter
  };
}

async function renderTouch(pool, enrollment, stepNumber) {
  // Look up recipient profile (for merge tags + addressing)
  const emailExpr = _coalesceEmailExpr('p');
  const r = await pool.query(
    `SELECT p.*, ${emailExpr} AS resolved_email
     FROM ${RECIPIENT_TABLE} p WHERE p.id = $1 LIMIT 1`,
    [enrollment.recipient_id]
  );
  if (r.rows.length === 0) {
    return { ok: false, reason: 'recipient row missing' };
  }
  const recipient = r.rows[0];

  // Resolve variant for Touch 2/5 conditional ship
  const variant = await _resolveVariant(pool, stepNumber);
  let template = await _loadTemplate(pool, stepNumber, variant);
  if (!template && variant !== 'default') {
    // Fallback to default if Lite variant not loaded
    template = await _loadTemplate(pool, stepNumber, 'default');
  }
  if (!template) {
    return { ok: false, reason: `no template for step ${stepNumber} variant ${variant}` };
  }

  // Apply founding-cohort merge tags + Subject A/B selection
  const state = await foundingCohort.getState(pool);
  const subjChoice = foundingCohort.chooseSubject({
    subject_a: foundingCohort.resolveMergeTags(template.subject_a, state),
    subject_b: foundingCohort.resolveMergeTags(template.subject_b, state),
    state
  });

  // Substitute additional merge tags
  const firstName = recipient.first_name || (recipient.full_name || '').split(' ')[0] || 'there';
  const province = recipient.province || '';
  let bodyText = foundingCohort.resolveMergeTags(template.body_text || '', state);
  let bodyHtml = foundingCohort.resolveMergeTags(template.body_html || '', state);
  bodyText = bodyText
    .replace(/\{\{first_name\}\}/g, firstName)
    .replace(/\{\{province\}\}/g, province);
  bodyHtml = bodyHtml
    .replace(/\{\{first_name\}\}/g, firstName)
    .replace(/\{\{province\}\}/g, province);
  bodyText = profileTags.apply(bodyText, recipient);
  bodyHtml = profileTags.apply(bodyHtml, recipient);
  const unsubUrl = unsubscribeToken.makeUrl(recipient.resolved_email);
  bodyText = bodyText.replace(/\{\{unsubscribe_url\}\}/g, unsubUrl);
  bodyHtml = bodyHtml.replace(/\{\{unsubscribe_url\}\}/g, unsubUrl);

  const footed = _appendCASLFooter(bodyText, bodyHtml);

  return {
    ok: true,
    recipient_email: recipient.resolved_email,
    subject: subjChoice.subject,
    ab_variant: subjChoice.variant,
    text: footed.text,
    html: footed.html,
    variant_used: variant
  };
}

async function _send(rendered) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'noreply@canadaaccountants.app';
  const result = await resend.emails.send({
    from: fromEmail,
    to: rendered.recipient_email,
    replyTo: 'arthur@canadaaccountants.app',
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html
  });
  return result?.data?.id || null;
}

async function _advanceState(pool, enrollment, sentResendId) {
  // Find current step's index in the array, advance to next array entry.
  // Uses array order (not step number arithmetic) so CBE's gap at step 3 is handled.
  const currentIdx = SEQUENCE_STEPS.findIndex(s => s.step === enrollment.current_step + 1);
  const completedStep = SEQUENCE_STEPS[currentIdx].step;
  const nextStep = SEQUENCE_STEPS[currentIdx + 1];
  const nextSendAtBase = SEQUENCE_STEPS.find(s => s.step === completedStep)?.delay_days ?? 0;
  const nextDelay = nextStep ? (nextStep.delay_days - nextSendAtBase) : 0;
  const nextSendAt = nextStep ? new Date(Date.now() + nextDelay * 86400 * 1000) : null;
  const isComplete = !nextStep;
  await pool.query(
    `UPDATE v2_supply_enrollments
     SET current_step = $1, next_send_at = $2, last_touch_sent_at = NOW(),
         last_touch_resend_id = $3,
         completed_at = CASE WHEN $4 THEN NOW() ELSE completed_at END,
         exit_reason = CASE WHEN $4 THEN 'completed' ELSE exit_reason END
     WHERE id = $5`,
    [completedStep, nextSendAt, sentResendId, isComplete, enrollment.id]
  );
}

async function _completeWithReason(pool, enrollment, reason) {
  await pool.query(
    `UPDATE v2_supply_enrollments
     SET completed_at = NOW(), exit_reason = $1
     WHERE id = $2`,
    [reason, enrollment.id]
  );
}

async function processOne(pool, enrollment) {
  const stopReason = await _checkStopConditions(pool, enrollment.recipient_email, enrollment.recipient_id);
  if (stopReason) {
    await _completeWithReason(pool, enrollment, stopReason);
    return { decision: 'stopped', reason: stopReason };
  }
  const stepNumber = enrollment.current_step + 1;
  const rendered = await renderTouch(pool, enrollment, stepNumber);
  if (!rendered.ok) {
    return { decision: 'render_failed', reason: rendered.reason };
  }
  if (!_isReadyToLaunch()) {
    // Launch gate: do not send unless V2_RUNNER_LAUNCH_READY=true.
    return { decision: 'gate_blocked', reason: 'V2_RUNNER_LAUNCH_READY!=true' };
  }
  let resendId;
  try {
    resendId = await _send(rendered);
  } catch (sendErr) {
    console.error(`[SequenceRunnerV2] send failed for enrollment ${enrollment.id}:`, sendErr.message);
    return { decision: 'send_failed', reason: sendErr.message };
  }
  await _advanceState(pool, enrollment, resendId);
  return { decision: 'sent', resend_id: resendId, step: stepNumber };
}

async function runOnce(pool) {
  const startedAt = new Date();
  // Honor deliverability-gate auto-pause: if the gate has paused this platform's
  // sequence (Section 4.5 — complaint > 0.3% or bounce > 2% over 24h window),
  // skip this run entirely. Manual unpause is required.
  try {
    const deliverabilityGate = require('./deliverability-gate');
    if (await deliverabilityGate.isPlatformPaused(pool)) {
      console.log(`[SequenceRunnerV2] ${startedAt.toISOString()}: skipped — platform paused by deliverability gate`);
      return { due: 0, sent: 0, gated: 0, stopped: 0, failed: 0, paused: true };
    }
  } catch (err) {
    console.error('[SequenceRunnerV2] gate check failed (proceeding):', err.message);
  }
  const r = await pool.query(
    `SELECT * FROM v2_supply_enrollments
     WHERE platform = $1 AND completed_at IS NULL
       AND next_send_at IS NOT NULL AND next_send_at <= NOW()
     ORDER BY next_send_at ASC
     LIMIT 50`,
    [PLATFORM]
  );
  let sent = 0, gated = 0, stopped = 0, failed = 0;
  for (const enrollment of r.rows) {
    try {
      const result = await processOne(pool, enrollment);
      switch (result.decision) {
        case 'sent': sent++; break;
        case 'gate_blocked': gated++; break;
        case 'stopped': stopped++; break;
        default: failed++;
      }
    } catch (err) {
      console.error(`[SequenceRunnerV2] enrollment ${enrollment.id} error:`, err.message);
      failed++;
    }
  }
  if (r.rows.length > 0) {
    console.log(`[SequenceRunnerV2] ${startedAt.toISOString()}: due=${r.rows.length} sent=${sent} gated=${gated} stopped=${stopped} failed=${failed}`);
  }
  return { due: r.rows.length, sent, gated, stopped, failed };
}

async function enrollOne(pool, recipientId) {
  const emailExpr = _coalesceEmailExpr('p');
  const r = await pool.query(
    `SELECT id, ${emailExpr} AS email FROM ${RECIPIENT_TABLE} p WHERE p.id = $1 LIMIT 1`,
    [recipientId]
  );
  if (r.rows.length === 0 || !r.rows[0].email) {
    throw new Error(`recipient ${recipientId} missing or has no email`);
  }
  const recipient = r.rows[0];
  // Deterministic A/B hash: bucket by recipient_id
  const ab = recipientId % 2 === 0 ? 'a' : 'b';
  const ins = await pool.query(
    `INSERT INTO v2_supply_enrollments
       (recipient_id, recipient_email, platform, sequence_name, current_step, next_send_at, ab_cohort)
     VALUES ($1, $2, $3, $4, 0, NOW(), $5)
     ON CONFLICT (recipient_id, platform, sequence_name) DO NOTHING
     RETURNING id`,
    [recipientId, recipient.email, PLATFORM, SEQUENCE_NAME, ab]
  );
  return { enrollment_id: ins.rows[0]?.id, duplicate: ins.rowCount === 0 };
}

async function enrollCohort(pool, recipientIds) {
  let enrolled = 0, duplicates = 0, errored = 0;
  for (const id of recipientIds) {
    try {
      const r = await enrollOne(pool, id);
      if (r.duplicate) duplicates++; else enrolled++;
    } catch (err) {
      console.error(`[SequenceRunnerV2] enroll ${id} failed:`, err.message);
      errored++;
    }
  }
  return { enrolled, duplicates, errored };
}

module.exports = {
  PLATFORM,
  SEQUENCE_NAME,
  SEQUENCE_STEPS,
  runOnce,
  processOne,
  renderTouch,
  enrollOne,
  enrollCohort
};
