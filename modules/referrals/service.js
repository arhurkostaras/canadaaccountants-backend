// modules/referrals/service.js
// Core referral logic: create, receive, match, accept, decline, connect, convert.
// Platform-specific pieces (the matcher, the email sender, Sentry) are injected
// as `deps` so this file stays identical across all four platforms.
//
// deps shape:
//   deps.matchInbound(pool, config, referralRow) -> Promise<{
//       matched_pro_id, matched_pro_name, matched_client_profile_id, match_reason
//     } | { matched: false }>
//   deps.notify.offerToPro / introToClient / statusToReferrer  (all dark-gated)
//   deps.incentives.issueOnConversion(pool, config, referral)
//   deps.captureError(err, ctx)

'use strict';

const crypto = require('crypto');

// Closed event-type set. Anything not here is a bug, not a new event.
const EVENT_TYPES = new Set([
  'created', 'transmitted', 'transmit_failed', 'received', 'matched', 'no_match',
  'offer_email_sent', 'accepted', 'declined', 'rematched', 'intro_email_sent',
  'status_email_sent', 'email_suppressed_dark', 'client_clicked', 'connected',
  'converted', 'converted_self_reported', 'credit_pending_review', 'credit_issued',
  'expired', 'cancelled', 'error',
]);

function newNetworkRefId() {
  return crypto.randomUUID();
}

function logError(deps, context, err) {
  console.error(`[referrals/service] ${context}:`, err && err.message ? err.message : err);
  if (deps && typeof deps.captureError === 'function') {
    try { deps.captureError(err, { context }); } catch (e) { console.error('[referrals/service] captureError failed:', e.message); }
  }
}

// Append-only audit trail. Accepts a pool or an in-txn client.
async function recordEvent(db, referralId, eventType, detail) {
  if (!EVENT_TYPES.has(eventType)) {
    // Loud: an unknown event type means the closed set drifted from the code.
    console.error(`[referrals/service] unknown event_type '${eventType}' - refusing to record silently`);
  }
  await db.query(
    `INSERT INTO network_referral_events (referral_id, event_type, detail) VALUES ($1, $2, $3)`,
    [referralId, eventType, detail ? JSON.stringify(detail) : null]
  );
}

// PLATFORM + '-' + 6 chars of Crockford-ish base32 (no I/L/O/U). Collision-checked
// against the live PRO_TABLE by the caller.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function randomCodeBody(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
async function generateUniqueReferralCode(pool, config) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = `${config.PLATFORM_ID}-${randomCodeBody(6)}`;
    const { rows } = await pool.query(
      `SELECT 1 FROM ${config.PRO_TABLE} WHERE referral_code = $1 LIMIT 1`,
      [code]
    );
    if (rows.length === 0) return code;
  }
  throw new Error('could not generate a collision-free referral_code after 10 attempts');
}

// --- shared validation (spec 5.1 steps 3-6) --------------------------------
// Returns { ok:true } or { ok:false, code, message }. Steps 1-2 (JWT + consent)
// are enforced by the caller: the JWT route enforces both; platform-originated
// referrals substitute the client's own consent record.
async function validateReferralInput(pool, config, input, deps) {
  const email = (input.client && input.client.email ? String(input.client.email) : '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, code: 422, message: 'A valid client email is required.' };
  }
  if (!config.REFER_TARGETS.includes(input.target_platform)) {
    return { ok: false, code: 422, message: `Cannot refer to ${input.target_platform} from ${config.PLATFORM_ID}.` };
  }

  // Step 3: ZeroBounce (injected). Circuit-breaker-open -> accept but flag.
  let emailUnvalidated = false;
  if (deps && typeof deps.validateEmail === 'function') {
    try {
      const zb = await deps.validateEmail(email);
      if (zb && zb.circuitOpen) {
        emailUnvalidated = true;
      } else if (zb && zb.blocked) {
        return { ok: false, code: 422, message: 'That email did not pass validation (invalid or disposable).' };
      }
    } catch (err) {
      // Validation outage must not silently drop the referral; flag and continue.
      logError(deps, 'zerobounce validation error', err);
      emailUnvalidated = true;
    }
  }

  // Step 4: suppression check (unsubscribed clients cannot be intro'd).
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM ${config.SUPPRESSION_TABLE} WHERE lower(${config.SUPPRESSION_EMAIL_COL}) = $1 LIMIT 1`,
      [email]
    );
    if (rows.length > 0) {
      return { ok: false, code: 409, message: 'That client has unsubscribed from this platform and cannot be emailed.' };
    }
  } catch (err) {
    logError(deps, 'suppression check error', err);
    // A failed suppression read is fail-closed: do not risk emailing a suppressed address.
    return { ok: false, code: 503, message: 'Suppression check unavailable, try again shortly.' };
  }

  // Step 6: duplicate guard (same referrer + client + target within window).
  if (input.referrerProId != null) {
    const { rows } = await pool.query(
      `SELECT id, network_ref_id, status FROM network_referrals
        WHERE direction = 'outbound' AND referrer_pro_id = $1
          AND lower(client_email) = $2 AND target_platform = $3
          AND created_at > now() - ($4 || ' days')::interval
        ORDER BY created_at DESC LIMIT 1`,
      [input.referrerProId, email, input.target_platform, String(config.DUPLICATE_WINDOW_DAYS)]
    );
    if (rows.length > 0) {
      return { ok: false, code: 409, message: 'You already referred this client to this platform recently.', existing: rows[0] };
    }
  }

  return { ok: true, emailUnvalidated, normalizedEmail: email };
}

// --- create outbound referral (JWT path, spec 5.1) -------------------------
async function createReferral(pool, config, input, deps) {
  // Step 5: per-pro daily rate limit.
  if (input.referrerProId != null) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM network_referrals
        WHERE direction = 'outbound' AND referrer_pro_id = $1 AND created_at > now() - interval '1 day'`,
      [input.referrerProId]
    );
    if (rows[0].n >= config.MAX_OUTBOUND_PER_DAY) {
      return { ok: false, code: 429, message: `Daily referral limit reached (${config.MAX_OUTBOUND_PER_DAY}).` };
    }
  }

  const valid = await validateReferralInput(pool, config, input, deps);
  if (!valid.ok) return valid;

  const networkRefId = newNetworkRefId();
  const client = input.client || {};
  const consentAt = input.consent_recorded_at || new Date().toISOString();

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const ins = await dbClient.query(
      `INSERT INTO network_referrals
        (network_ref_id, direction, source_platform, target_platform, referrer_pro_id,
         referrer_name, referrer_email, client_name, client_email, client_phone, client_province,
         need_category, need_notes, client_consented, consent_recorded_at, status, expires_at)
       VALUES ($1,'outbound',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,'offered',
               now() + ($14 || ' days')::interval)
       RETURNING id`,
      [
        networkRefId, config.PLATFORM_ID, input.target_platform, input.referrerProId || null,
        input.referrerName || null, input.referrerEmail || null,
        client.name || null, valid.normalizedEmail, client.phone || null, client.province || null,
        input.need_category, input.need_notes || null, consentAt, String(config.EXPIRY_DAYS),
      ]
    );
    const referralId = ins.rows[0].id;

    // Outbox row in the SAME txn as the referral - no fire-and-forget HTTP.
    const outboundPayload = {
      network_ref_id: networkRefId,
      source_platform: config.PLATFORM_ID,
      referrer: {
        pro_id: input.referrerProId || null,
        name: input.referrerName || null,
        email: input.referrerEmail || null,
      },
      client: {
        name: client.name || null,
        email: valid.normalizedEmail,
        phone: client.phone || null,
        province: client.province || null,
      },
      need_category: input.need_category,
      need_notes: input.need_notes || null,
      client_consented: true,
      consent_recorded_at: consentAt,
    };
    await dbClient.query(
      `INSERT INTO network_outbox (target_platform, endpoint, payload)
       VALUES ($1, '/api/network/referrals', $2)`,
      [input.target_platform, JSON.stringify(outboundPayload)]
    );

    await recordEvent(dbClient, referralId, 'created', {
      target_platform: input.target_platform,
      email_unvalidated: valid.emailUnvalidated || false,
      platform_originated: input.referrerProId == null,
      consent: input.consentDetail || null,
    });

    if (input.referrerProId != null) {
      await dbClient.query(
        `UPDATE ${config.PRO_TABLE} SET referrals_sent_count = referrals_sent_count + 1 WHERE id = $1`,
        [input.referrerProId]
      );
    }

    await dbClient.query('COMMIT');
    return { ok: true, code: 201, referral: { id: referralId, network_ref_id: networkRefId, status: 'offered' } };
  } catch (err) {
    await dbClient.query('ROLLBACK').catch((e) => logError(deps, 'rollback failed', e));
    logError(deps, 'createReferral', err);
    return { ok: false, code: 500, message: 'Could not create the referral.' };
  } finally {
    dbClient.release();
  }
}

// Platform-originated referral (Lawyers intake, CBE checklist). No JWT; consent
// comes from the client's own checkbox (copy + timestamp + IP recorded).
async function createPlatformReferral(pool, config, payload, deps) {
  return createReferral(pool, config, {
    target_platform: payload.target_platform,
    client: payload.client,
    need_category: payload.need_category,
    need_notes: payload.need_notes,
    referrerProId: null,
    referrerName: payload.referrer_name || `${config.PLATFORM_NAME} intake`,
    referrerEmail: null,
    consent_recorded_at: payload.consent_recorded_at,
    consentDetail: payload.consent_detail || null, // { copy, ip }
  }, deps);
}

// --- receive inbound referral (idempotent, spec 4.3 + 5.2) ------------------
async function receiveReferral(pool, config, payload, sourcePlatform) {
  const networkRefId = payload.network_ref_id;
  if (!networkRefId || !payload.client || !payload.client.email || !payload.need_category) {
    const err = new Error('missing required referral fields');
    err.badRequest = true;
    throw err;
  }

  // Idempotency: upsert on (network_ref_id, direction='inbound').
  const existing = await pool.query(
    `SELECT id, status FROM network_referrals WHERE network_ref_id = $1 AND direction = 'inbound'`,
    [networkRefId]
  );
  if (existing.rows.length > 0) {
    return { created: false, network_ref_id: networkRefId, status: existing.rows[0].status };
  }

  const referrer = payload.referrer || {};
  const client = payload.client || {};
  const ins = await pool.query(
    `INSERT INTO network_referrals
      (network_ref_id, direction, source_platform, target_platform, referrer_pro_id,
       referrer_name, referrer_email, client_name, client_email, client_phone, client_province,
       need_category, need_notes, client_consented, consent_recorded_at, status,
       accept_deadline_at, expires_at)
     VALUES ($1,'inbound',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'offered',NULL,
             now() + ($15 || ' days')::interval)
     ON CONFLICT (network_ref_id, direction) DO NOTHING
     RETURNING id`,
    [
      networkRefId, sourcePlatform, config.PLATFORM_ID, referrer.pro_id || null,
      referrer.name || null, referrer.email || null,
      client.name || null, String(client.email).trim().toLowerCase(), client.phone || null, client.province || null,
      payload.need_category, payload.need_notes || null,
      payload.client_consented === true, payload.consent_recorded_at || null, String(config.EXPIRY_DAYS),
    ]
  );
  if (ins.rows.length === 0) {
    // Concurrent duplicate delivery raced us; treat as idempotent success.
    const row = await pool.query(
      `SELECT id, status FROM network_referrals WHERE network_ref_id = $1 AND direction = 'inbound'`,
      [networkRefId]
    );
    return { created: false, network_ref_id: networkRefId, status: row.rows[0] ? row.rows[0].status : 'offered' };
  }
  const referralId = ins.rows[0].id;
  await recordEvent(pool, referralId, 'received', { source_platform: sourcePlatform });

  return { created: true, network_ref_id: networkRefId, status: 'offered', referralId };
}

// Run matching for a freshly-received (or re-matched) inbound referral. Kept
// separate so both receiveReferral's caller and the sweeper can invoke it.
async function matchInboundReferral(pool, config, referralId, deps) {
  const { rows } = await pool.query(`SELECT * FROM network_referrals WHERE id = $1`, [referralId]);
  if (rows.length === 0) return { matched: false };
  const referral = rows[0];

  let match;
  try {
    match = await deps.matchInbound(pool, config, referral);
  } catch (err) {
    logError(deps, 'matchInbound adapter error', err);
    await recordEvent(pool, referralId, 'error', { stage: 'match', message: err.message });
    return { matched: false };
  }

  if (!match || match.matched === false || !match.matched_pro_id) {
    await recordEvent(pool, referralId, 'no_match', { attempt: referral.match_attempts + 1 });
    return { matched: false };
  }

  const deadline = new Date(Date.now() + config.ACCEPT_WINDOW_HOURS * 3600 * 1000).toISOString();
  await pool.query(
    `UPDATE network_referrals
        SET matched_pro_id = $1, matched_client_profile_id = $2,
            match_attempts = match_attempts + 1, accept_deadline_at = $3, updated_at = now()
      WHERE id = $4`,
    [match.matched_pro_id, match.matched_client_profile_id || null, deadline, referralId]
  );
  await recordEvent(pool, referralId, 'matched', {
    matched_pro_id: match.matched_pro_id,
    match_reason: match.match_reason || null,
    attempt: referral.match_attempts + 1,
  });

  // Dark-gated offer email to the matched pro.
  await deps.notify.offerToPro(pool, config, {
    ...referral,
    matched_pro_id: match.matched_pro_id,
    matched_pro_name: match.matched_pro_name,
    matched_pro_email: match.matched_pro_email || null,
  });
  return { matched: true, matched_pro_id: match.matched_pro_id };
}

// --- receive a status update pushed back by a peer --------------------------
async function receiveStatusUpdate(pool, config, networkRefId, payload, sourcePlatform) {
  const status = payload.status;
  const VALID = ['accepted', 'declined', 'connected', 'converted', 'expired', 'cancelled'];
  if (!VALID.includes(status)) {
    const err = new Error(`invalid status '${status}'`);
    err.badRequest = true;
    throw err;
  }
  // A peer only updates OUR outbound copy (their inbound drove the change).
  const { rows } = await pool.query(
    `UPDATE network_referrals SET status = $1, updated_at = now()
      WHERE network_ref_id = $2 AND direction = 'outbound'
      RETURNING id`,
    [status, networkRefId]
  );
  if (rows.length === 0) return { ok: true, note: 'no local outbound copy' };
  const referralId = rows[0].id;
  await recordEvent(pool, referralId, status === 'converted' ? 'converted' : status, {
    via: 'peer_status_sync', source_platform: sourcePlatform, detail: payload.detail || null,
  });
  return { ok: true, referralId };
}

// --- resolve a local referral code (peer asks us via HMAC) ------------------
async function resolveLocalCode(pool, config, code) {
  const { rows } = await pool.query(
    `SELECT id, COALESCE(full_name, first_name, name, 'CPA') AS pro_name
       FROM ${config.PRO_TABLE} WHERE referral_code = $1 LIMIT 1`,
    [code]
  ).catch(async () => {
    // Column set differs per platform; fall back to id + referral_code only.
    return pool.query(`SELECT id FROM ${config.PRO_TABLE} WHERE referral_code = $1 LIMIT 1`, [code]);
  });
  if (!rows || rows.length === 0) return { valid: false, platform: config.PLATFORM_ID };
  return { valid: true, platform: config.PLATFORM_ID, pro_id: rows[0].id, pro_name: rows[0].pro_name || null };
}

// --- accept / decline / connected (receiving pro, inbound only) -------------
async function acceptReferral(pool, config, referralId, proId, deps) {
  const { rows } = await pool.query(
    `SELECT * FROM network_referrals WHERE id = $1 AND direction = 'inbound'`, [referralId]
  );
  if (rows.length === 0) return { ok: false, code: 404, message: 'Referral not found.' };
  const referral = rows[0];
  if (referral.matched_pro_id !== proId) return { ok: false, code: 403, message: 'This referral is not offered to you.' };
  if (referral.status !== 'offered') return { ok: false, code: 409, message: `Referral is already ${referral.status}.` };

  await pool.query(`UPDATE network_referrals SET status = 'accepted', updated_at = now() WHERE id = $1`, [referralId]);
  await recordEvent(pool, referralId, 'accepted', { pro_id: proId });
  await deps.enqueuePeerStatus(pool, referral, 'accepted');
  await deps.notify.introToClient(pool, config, referral);
  await deps.notify.statusToReferrer(pool, config, referral, 'accepted');
  return { ok: true };
}

async function declineReferral(pool, config, referralId, proId, reason, deps) {
  const { rows } = await pool.query(
    `SELECT * FROM network_referrals WHERE id = $1 AND direction = 'inbound'`, [referralId]
  );
  if (rows.length === 0) return { ok: false, code: 404, message: 'Referral not found.' };
  const referral = rows[0];
  if (referral.matched_pro_id !== proId) return { ok: false, code: 403, message: 'This referral is not offered to you.' };

  await recordEvent(pool, referralId, 'declined', { pro_id: proId, reason: reason || null });
  await rematchOrExpire(pool, config, referral, deps, 'declined');
  return { ok: true };
}

async function markConnected(pool, config, referralId, proId, deps) {
  const { rows } = await pool.query(
    `SELECT * FROM network_referrals WHERE id = $1 AND direction = 'inbound'`, [referralId]
  );
  if (rows.length === 0) return { ok: false, code: 404, message: 'Referral not found.' };
  const referral = rows[0];
  if (referral.matched_pro_id !== proId) return { ok: false, code: 403, message: 'Not your referral.' };
  if (!['accepted', 'connected'].includes(referral.status)) {
    return { ok: false, code: 409, message: `Cannot connect from status ${referral.status}.` };
  }
  await pool.query(`UPDATE network_referrals SET status = 'connected', updated_at = now() WHERE id = $1`, [referralId]);
  await recordEvent(pool, referralId, 'connected', { pro_id: proId });
  await deps.enqueuePeerStatus(pool, referral, 'connected');
  await deps.notify.statusToReferrer(pool, config, referral, 'connected');
  return { ok: true };
}

// Re-match to the next-best pro, or expire after MAX_MATCH_ATTEMPTS. Shared by
// decline and the 48h-timeout sweeper.
async function rematchOrExpire(pool, config, referral, deps, cause) {
  if (referral.match_attempts >= config.MAX_MATCH_ATTEMPTS) {
    await pool.query(`UPDATE network_referrals SET status = 'expired', updated_at = now() WHERE id = $1`, [referral.id]);
    await recordEvent(pool, referral.id, 'expired', { cause, attempts: referral.match_attempts });
    await deps.enqueuePeerStatus(pool, referral, 'expired');
    await deps.notify.statusToReferrer(pool, config, referral, 'expired');
    return { expired: true };
  }
  // Reset to offered and re-run matching (adapter should exclude prior matched pro).
  await pool.query(
    `UPDATE network_referrals SET status = 'offered', matched_pro_id = NULL, accept_deadline_at = NULL, updated_at = now()
      WHERE id = $1`,
    [referral.id]
  );
  await recordEvent(pool, referral.id, 'rematched', { cause, next_attempt: referral.match_attempts + 1 });
  return matchInboundReferral(pool, config, referral.id, deps);
}

// --- conversion (spec 5.3) --------------------------------------------------
// Auto-verified path issues the credit immediately; self-report gates it behind
// an admin review (credit lands 'pending_review', no Stripe until approved).
async function convertReferral(pool, config, referralId, opts, deps) {
  const { rows } = await pool.query(`SELECT * FROM network_referrals WHERE id = $1`, [referralId]);
  if (rows.length === 0) return { ok: false, code: 404, message: 'Referral not found.' };
  const referral = rows[0];
  const selfReported = opts && opts.selfReported === true;

  await pool.query(
    `UPDATE network_referrals SET status = 'converted', converted_value_cents = $2, updated_at = now() WHERE id = $1`,
    [referralId, (opts && opts.value_cents) || null]
  );
  await recordEvent(pool, referralId, selfReported ? 'converted_self_reported' : 'converted', {
    reported_by: (opts && opts.reportedBy) || null,
  });
  await deps.enqueuePeerStatus(pool, referral, 'converted');

  // Credit accrues to the referrer on the SOURCE platform (where they subscribe).
  // On the inbound (receiving) side we sync status; the source side issues credit
  // when it receives that status. Only issue here if we ARE the source (outbound copy).
  if (referral.direction === 'outbound') {
    await deps.incentives.issueOnConversion(pool, config, referral, { pendingReview: selfReported });
  }
  return { ok: true };
}

module.exports = {
  EVENT_TYPES,
  recordEvent,
  newNetworkRefId,
  generateUniqueReferralCode,
  validateReferralInput,
  createReferral,
  createPlatformReferral,
  receiveReferral,
  matchInboundReferral,
  receiveStatusUpdate,
  resolveLocalCode,
  acceptReferral,
  declineReferral,
  markConnected,
  rematchOrExpire,
  convertReferral,
};
