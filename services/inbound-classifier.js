// Inbound classifier worker (Section 4.1 + Section 4.10 of campaign brief v1.7).
// Polls inbound_messages where classification_status='pending', applies Section 4.10
// classifier rules to detect "breakdown" triggers, and routes to the breakdown
// auto-reply path. Non-breakdown pending rows stay pending (a later build implements
// the full Section 4.10 reply handler).
//
// Build 2 of Phase 3. Auto-send is gated by BREAKDOWN_AUTO_REPLY_ENABLED env var
// (default 'false'). Until Arthur reviews the 20-profile rubric and flips the flag,
// breakdown matches are queued in breakdown_replies with status='pending_arthur_approval'.

const crypto = require('crypto');
const { Resend } = require('resend');
const breakdown = require('./breakdown');

const PLATFORM = breakdown.PLATFORM;
const RECIPIENT_TABLE = 'scraped_cpas';
const RECIPIENT_EMAIL_COLS = ['enriched_email', 'email'];
const RATE_LIMIT_PER_24H = parseInt(process.env.BREAKDOWN_DAILY_CAP || '100', 10);

// Section 4.10 classifier rule for "breakdown":
// reply body ≤ 300 chars AND contains "breakdown" (case-insensitive, whole-word)
function _isBreakdownTrigger(bodyText) {
  if (!bodyText) return false;
  if (bodyText.length > 300) return false;
  return /\bbreakdown\b/i.test(bodyText);
}

function _isLongBreakdownAmbiguous(bodyText) {
  if (!bodyText) return false;
  return bodyText.length > 300 && /\bbreakdown\b/i.test(bodyText);
}

// Section 4.10 unsubscribe rule: ≤50 chars + any of the listed phrases.
// Whole-word match avoids false positives like "Don't unsubscribe me, I'm interested".
const UNSUB_REGEX = /\b(unsubscribe|unsub|opt[\s-]?out|stop|remove[\s_-]?me)\b/i;
function _isUnsubscribeTrigger(bodyText) {
  if (!bodyText) return false;
  if (bodyText.length > 50) return false;
  return UNSUB_REGEX.test(bodyText);
}
function _isLongUnsubscribeAmbiguous(bodyText) {
  if (!bodyText) return false;
  return bodyText.length > 50 && UNSUB_REGEX.test(bodyText);
}

// Section 4.10 Touch 7 acceptance/decline. Only meaningful if recipient is at Touch 7.
const TOUCH7_IN_REGEX = /^\s*(in|i'?m\s+in|i\s+am\s+in|yes\s+i'?m\s+in|count\s+me\s+in)\s*[!.]?\s*$/i;
const TOUCH7_OUT_REGEX = /^\s*(out|i'?m\s+out|i\s+am\s+out|no\s+thanks?|pass)\s*[!.]?\s*$/i;
function _isTouch7Acceptance(bodyText) {
  if (!bodyText || bodyText.length > 30) return false;
  return TOUCH7_IN_REGEX.test(bodyText.trim());
}
function _isTouch7Decline(bodyText) {
  if (!bodyText || bodyText.length > 30) return false;
  return TOUCH7_OUT_REGEX.test(bodyText.trim());
}

async function _findRecipient(pool, fromEmail) {
  const e = (fromEmail || '').toLowerCase().trim();
  if (!e) return null;
  for (const col of RECIPIENT_EMAIL_COLS) {
    const r = await pool.query(`SELECT * FROM ${RECIPIENT_TABLE} WHERE LOWER(${col}) = $1 LIMIT 1`, [e]);
    if (r.rows.length > 0) return r.rows[0];
  }
  return null;
}

async function _isSuppressed(pool, fromEmail) {
  const e = (fromEmail || '').toLowerCase().trim();
  if (!e) return false;
  const r = await pool.query(`SELECT 1 FROM outreach_unsubscribes WHERE LOWER(email) = $1 LIMIT 1`, [e]);
  return r.rows.length > 0;
}

async function _underRateLimit(pool) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS sent_count
     FROM breakdown_replies
     WHERE status = 'sent' AND breakdown_sent_at > NOW() - INTERVAL '24 hours'`
  );
  return (r.rows[0]?.sent_count || 0) < RATE_LIMIT_PER_24H;
}

async function _markInbound(pool, inboundId, status, decision) {
  await pool.query(
    `UPDATE inbound_messages SET classification_status = $1, classification_decision = $2, processed_at = NOW() WHERE id = $3`,
    [status, decision, inboundId]
  );
}

async function _claimBreakdownSlot(pool, fromEmail, inboundId, repliedAt) {
  // Idempotent insert: returns existing row if (recipient_email, platform) already exists
  const r = await pool.query(
    `INSERT INTO breakdown_replies (recipient_email, platform, inbound_message_id, replied_at, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (recipient_email, platform) DO NOTHING
     RETURNING id, status`,
    [fromEmail, PLATFORM, inboundId, repliedAt]
  );
  if (r.rowCount > 0) return { id: r.rows[0].id, isNew: true, existingStatus: null };
  // Already exists — fetch it
  const existing = await pool.query(
    `SELECT id, status FROM breakdown_replies WHERE recipient_email = $1 AND platform = $2 LIMIT 1`,
    [fromEmail, PLATFORM]
  );
  return { id: existing.rows[0].id, isNew: false, existingStatus: existing.rows[0].status };
}

async function _updateBreakdownReply(pool, id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i++}`);
    vals.push(v);
  }
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  await pool.query(`UPDATE breakdown_replies SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

async function _sendBreakdownEmail(recipientEmail, composed) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'noreply@canadaaccountants.app';
  const replyTo = `arthur@canadaaccountants.app`;
  const result = await resend.emails.send({
    from: fromEmail,
    to: recipientEmail,
    replyTo,
    subject: 'Your AI breakdown — as requested',
    text: composed.text,
    html: composed.html
  });
  return result?.data?.id || null;
}

// Section 4.10 unsubscribe handler: write to outreach_unsubscribes (idempotent),
// send brief confirmation reply, mark inbound classified.
async function _handleUnsubscribe(pool, inboundId, fromEmail) {
  const lower = (fromEmail || '').toLowerCase().trim();
  if (!lower) {
    await _markInbound(pool, inboundId, 'manual_review', 'unsubscribe');
    return { decision: 'unsubscribe_no_email' };
  }
  await pool.query(
    `INSERT INTO outreach_unsubscribes (email, reason, unsubscribed_at)
     VALUES ($1, 'reply_unsubscribe', NOW())
     ON CONFLICT (email) DO NOTHING`,
    [lower]
  );
  // Send confirmation
  if (process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.FROM_EMAIL || 'noreply@canadaaccountants.app',
        to: lower,
        replyTo: 'arthur@canadaaccountants.app',
        subject: 'Unsubscribed',
        text: `Unsubscribed. You won't hear from me again.\n\n— Arthur Kostaras`
      });
    } catch (e) { console.error('[InboundClassifier] unsubscribe confirmation failed:', e.message); }
  }
  await _markInbound(pool, inboundId, 'classified', 'unsubscribe');
  return { decision: 'unsubscribed' };
}

// Section 4.10 catch-all: auto-acknowledge so the recipient knows we received it,
// then route to Arthur for manual review.
async function _handleCatchAll(pool, inboundId, fromEmail) {
  const lower = (fromEmail || '').toLowerCase().trim();
  if (lower && process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.FROM_EMAIL || 'noreply@canadaaccountants.app',
        to: lower,
        replyTo: 'arthur@canadaaccountants.app',
        subject: 'Got it',
        text: `Got it — Arthur will read this directly and reply within two business days.\n\n— Arthur Kostaras`
      });
    } catch (e) { console.error('[InboundClassifier] catch-all ack failed:', e.message); }
  }
  await _markInbound(pool, inboundId, 'manual_review', 'manual');
  return { decision: 'catch_all_routed_to_arthur' };
}

// Section 4.10 Touch 7 acceptance/decline. Looks up the recipient's v2 enrollment
// to confirm they are at Touch 7 (current_step >= 7). If yes, dispatches accordingly.
// Returns null if recipient is not at Touch 7 (caller falls through to other rules).
async function _maybeHandleTouch7Reply(pool, inboundId, fromEmail, bodyText) {
  if (!_isTouch7Acceptance(bodyText) && !_isTouch7Decline(bodyText)) return null;
  const lower = (fromEmail || '').toLowerCase().trim();
  if (!lower) return null;
  let enrollment;
  try {
    const r = await pool.query(
      `SELECT id, current_step, sequence_name FROM v2_supply_enrollments
       WHERE LOWER(recipient_email) = $1 AND platform = $2 AND completed_at IS NULL
       LIMIT 1`,
      [lower, PLATFORM]
    );
    enrollment = r.rows[0];
  } catch (_) { /* table may not exist yet on some backends; non-fatal */ }
  if (!enrollment || enrollment.current_step < 7) return null;
  if (_isTouch7Acceptance(bodyText)) {
    // Flag for Arthur manual enrollment — do not auto-enroll
    await _markInbound(pool, inboundId, 'classified', 'touch7_in');
    return { decision: 'touch7_acceptance_flagged' };
  }
  // Touch 7 decline → close enrollment + add to suppression
  await pool.query(
    `UPDATE v2_supply_enrollments SET completed_at = NOW(), exit_reason = 'touch7_out' WHERE id = $1`,
    [enrollment.id]
  );
  await pool.query(
    `INSERT INTO outreach_unsubscribes (email, reason, unsubscribed_at)
     VALUES ($1, 'touch7_out', NOW())
     ON CONFLICT (email) DO NOTHING`,
    [lower]
  );
  await _markInbound(pool, inboundId, 'classified', 'touch7_out');
  return { decision: 'touch7_decline_closed' };
}

async function processOne(pool, inboundRow) {
  const { id: inboundId, from_email, body_text, received_at } = inboundRow;

  // 1. Long body containing "breakdown" → manual review
  if (_isLongBreakdownAmbiguous(body_text)) {
    await _markInbound(pool, inboundId, 'manual_review', 'manual');
    return { decision: 'manual_review_long_body' };
  }

  // 2. Section 4.10 unsubscribe: short body + unsub phrase → auto-suppress + confirm
  if (_isUnsubscribeTrigger(body_text)) {
    return await _handleUnsubscribe(pool, inboundId, from_email);
  }
  if (_isLongUnsubscribeAmbiguous(body_text)) {
    await _markInbound(pool, inboundId, 'manual_review', 'manual');
    return { decision: 'manual_review_long_unsub' };
  }

  // 3. Section 4.10 Touch 7 in/out (only if recipient is at Touch 7)
  const t7 = await _maybeHandleTouch7Reply(pool, inboundId, from_email, body_text);
  if (t7) return t7;

  // 4. Not a breakdown trigger → catch-all auto-acknowledge per Section 4.10
  if (!_isBreakdownTrigger(body_text)) {
    return await _handleCatchAll(pool, inboundId, from_email);
  }

  // 5. Breakdown trigger matched. Claim the slot in breakdown_replies (idempotent).
  const slot = await _claimBreakdownSlot(pool, from_email, inboundId, received_at);
  if (!slot.isNew && slot.existingStatus === 'sent') {
    await _markInbound(pool, inboundId, 'classified', 'breakdown');
    return { decision: 'duplicate_already_sent' };
  }

  // 4. Suppression check
  if (await _isSuppressed(pool, from_email)) {
    await _updateBreakdownReply(pool, slot.id, { status: 'suppressed', failure_reason: 'recipient on outreach_unsubscribes' });
    await _markInbound(pool, inboundId, 'classified', 'breakdown');
    return { decision: 'suppressed' };
  }

  // 5. Rate limit
  if (!(await _underRateLimit(pool))) {
    await _updateBreakdownReply(pool, slot.id, { status: 'rate_limited', failure_reason: `daily cap of ${RATE_LIMIT_PER_24H} reached` });
    await _markInbound(pool, inboundId, 'classified', 'breakdown');
    return { decision: 'rate_limited' };
  }

  // 6. Look up recipient profile
  const recipient = await _findRecipient(pool, from_email);
  if (!recipient) {
    await _updateBreakdownReply(pool, slot.id, { status: 'manual_review', failure_reason: 'recipient not found in scraped table' });
    await _markInbound(pool, inboundId, 'manual_review', 'breakdown');
    return { decision: 'recipient_not_found' };
  }

  // 7. Score + compose
  const scoreResult = breakdown.score(recipient);
  const composed = breakdown.compose(scoreResult, recipient);
  if (!composed.ok) {
    await _updateBreakdownReply(pool, slot.id, {
      status: 'manual_review',
      failure_reason: composed.reason,
      breakdown_payload: JSON.stringify({ score: scoreResult, populated_count: scoreResult.populated_count })
    });
    await _markInbound(pool, inboundId, 'manual_review', 'breakdown');
    return { decision: 'compose_insufficient_data' };
  }

  // 8. Auto-send gate
  const autoEnabled = process.env.BREAKDOWN_AUTO_REPLY_ENABLED === 'true';
  if (!autoEnabled) {
    await _updateBreakdownReply(pool, slot.id, {
      status: 'pending_arthur_approval',
      breakdown_payload: JSON.stringify({ score: scoreResult, text: composed.text }),
      breakdown_payload_hash: composed.payload_hash
    });
    await _markInbound(pool, inboundId, 'classified', 'breakdown');
    return { decision: 'gated_pending_approval' };
  }

  // 9. Send
  try {
    const resendId = await _sendBreakdownEmail(from_email, composed);
    await _updateBreakdownReply(pool, slot.id, {
      status: 'sent',
      breakdown_sent_at: new Date().toISOString(),
      breakdown_payload: JSON.stringify({ score: scoreResult, text: composed.text }),
      breakdown_payload_hash: composed.payload_hash,
      sent_resend_id: resendId
    });
    await _markInbound(pool, inboundId, 'classified', 'breakdown');
    return { decision: 'sent', resend_id: resendId };
  } catch (sendErr) {
    console.error('[InboundClassifier] send failed:', sendErr.message);
    await _updateBreakdownReply(pool, slot.id, {
      status: 'failed',
      failure_reason: sendErr.message
    });
    return { decision: 'send_failed' };
  }
}

async function runOnce(pool) {
  const startedAt = new Date();
  let processed = 0;
  let breakdownMatched = 0;
  let sent = 0;
  let queued = 0;
  let suppressed = 0;
  let rateLimited = 0;
  let manualReview = 0;
  let skipped = 0;

  const r = await pool.query(
    `SELECT id, from_email, body_text, received_at
     FROM inbound_messages
     WHERE classification_status = 'pending' AND received_at > NOW() - INTERVAL '24 hours'
     ORDER BY received_at ASC
     LIMIT 50`
  );

  for (const row of r.rows) {
    processed++;
    try {
      const result = await processOne(pool, row);
      switch (result.decision) {
        case 'sent': sent++; breakdownMatched++; break;
        case 'gated_pending_approval': queued++; breakdownMatched++; break;
        case 'suppressed': suppressed++; breakdownMatched++; break;
        case 'rate_limited': rateLimited++; breakdownMatched++; break;
        case 'manual_review_long_body':
        case 'recipient_not_found':
        case 'compose_insufficient_data': manualReview++; if (result.decision !== 'manual_review_long_body') breakdownMatched++; break;
        case 'duplicate_already_sent': breakdownMatched++; break;
        case 'not_breakdown_skip': skipped++; break;
        default: skipped++;
      }
    } catch (perRowErr) {
      console.error(`[InboundClassifier] row ${row.id} error:`, perRowErr.message);
    }
  }

  if (processed > 0) {
    console.log(`[InboundClassifier] ${startedAt.toISOString()}: processed=${processed} breakdown_matched=${breakdownMatched} sent=${sent} queued=${queued} suppressed=${suppressed} rate_limited=${rateLimited} manual_review=${manualReview} skipped=${skipped}`);
  }
  return { processed, breakdownMatched, sent, queued, suppressed, rateLimited, manualReview, skipped };
}

module.exports = { runOnce, processOne, _isBreakdownTrigger };
