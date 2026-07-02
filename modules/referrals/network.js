// modules/referrals/network.js
// Outbound delivery + background workers.
//   - enqueuePeerStatus: write a status-sync row to the outbox (in-band, no HTTP)
//   - startOutboxWorker: flush the outbox with a DB-ATOMIC row claim (correct even
//     if an app ever runs >1 Railway replica - a double-sent intro email is a
//     client-facing failure, not an ops nuisance)
//   - startSweeper: time-driven transitions (48h accept timeout, expiry, credit
//     expiry) that nothing else enforces

'use strict';

const cron = require('node-cron');
const hmac = require('./hmac');

const OUTBOX_INTERVAL_MS = 60 * 1000;
const OUTBOX_BATCH = 20;

// Resolve the peer platform that holds the OTHER copy of a referral.
function peerOf(config, referral) {
  return referral.direction === 'inbound' ? referral.source_platform : referral.target_platform;
}

// Queue a status update to the peer. Written to the outbox like any other
// outbound payload so it inherits retry/backoff and never fires HTTP inline.
async function enqueuePeerStatus(pool, referral, status, detail) {
  const target = referral.direction === 'inbound' ? referral.source_platform : referral.target_platform;
  const endpoint = `/api/network/referrals/${referral.network_ref_id}/status`;
  await pool.query(
    `INSERT INTO network_outbox (target_platform, endpoint, payload)
     VALUES ($1, $2, $3)`,
    [target, endpoint, JSON.stringify({ status, detail: detail || null })]
  );
}

// Sign + POST one outbox payload to a peer. Returns { ok, status }.
async function deliver(config, row) {
  const base = config.peers[row.target_platform];
  if (!base) return { ok: false, status: 0, error: `no peer URL for ${row.target_platform}` };
  if (!config.NETWORK_SHARED_SECRET) return { ok: false, status: 0, error: 'NETWORK_SHARED_SECRET not set' };
  if (typeof fetch !== 'function') return { ok: false, status: 0, error: 'global fetch unavailable (need Node 18+)' };

  const rawBody = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hmac.sign(config.NETWORK_SHARED_SECRET, timestamp, rawBody);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${base}${row.endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Network-Platform': config.PLATFORM_ID,
        'X-Network-Timestamp': timestamp,
        'X-Network-Signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    // 2xx is success (including the idempotent 200 for a duplicate).
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// One flush pass. Claims a batch atomically, then delivers each claimed row.
async function flushOutbox(pool, config, deps) {
  // Atomic claim: increment attempts + push next_attempt_at into the future so a
  // concurrent worker cannot grab the same rows. Backoff is keyed on the PRE-update
  // attempts value (SQL evaluates SET expressions against the old row).
  const claim = await pool.query(
    `UPDATE network_outbox SET
        attempts = attempts + 1,
        next_attempt_at = now() + (CASE
          WHEN attempts = 0 THEN interval '1 minute'
          WHEN attempts = 1 THEN interval '5 minutes'
          WHEN attempts = 2 THEN interval '30 minutes'
          WHEN attempts = 3 THEN interval '2 hours'
          WHEN attempts = 4 THEN interval '12 hours'
          ELSE interval '1 day' END)
      WHERE id IN (
        SELECT id FROM network_outbox
         WHERE delivered_at IS NULL AND next_attempt_at <= now()
         ORDER BY id
         LIMIT ${OUTBOX_BATCH}
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`
  );

  for (const row of claim.rows) {
    let result;
    try {
      result = await deliver(config, row);
    } catch (err) {
      result = { ok: false, status: 0, error: err.message };
    }
    if (result.ok) {
      await pool.query(`UPDATE network_outbox SET delivered_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
    } else {
      const msg = result.error || `HTTP ${result.status}`;
      await pool.query(`UPDATE network_outbox SET last_error = $2 WHERE id = $1`, [row.id, msg]);
      // Loud on the terminal attempt so a stuck peer is visible, not silent.
      if (row.attempts + 1 >= 5) {
        console.error(`[referrals/outbox] row ${row.id} -> ${row.target_platform}${row.endpoint} failed after ${row.attempts + 1} attempts: ${msg}`);
        if (typeof deps.captureError === 'function') {
          try { deps.captureError(new Error(`outbox delivery exhausted: ${msg}`), { rowId: row.id, target: row.target_platform }); }
          catch (e) { console.error('[referrals/outbox] captureError failed:', e.message); }
        }
      } else {
        console.error(`[referrals/outbox] row ${row.id} attempt ${row.attempts + 1} failed: ${msg} (will retry)`);
      }
    }
  }
  return claim.rows.length;
}

function startOutboxWorker(pool, config, deps) {
  const tick = async () => {
    try {
      await flushOutbox(pool, config, deps);
    } catch (err) {
      console.error('[referrals/outbox] flush pass error:', err.message);
      if (typeof deps.captureError === 'function') {
        try { deps.captureError(err, { context: 'outbox flush' }); } catch (e) { console.error('[referrals/outbox] captureError failed:', e.message); }
      }
    }
  };
  const handle = setInterval(tick, OUTBOX_INTERVAL_MS);
  if (handle.unref) handle.unref();
  console.log(`[referrals] outbox worker started (every ${OUTBOX_INTERVAL_MS / 1000}s)`);
  return handle;
}

// Sweeper: 48h accept timeouts, referral expiry, credit expiry. Every 15 min.
function startSweeper(pool, config, service, deps) {
  const task = cron.schedule('*/15 * * * *', async () => {
    // (a) offered inbound past their 48h accept window -> re-match or expire.
    try {
      const due = await pool.query(
        `SELECT * FROM network_referrals
          WHERE direction = 'inbound' AND status = 'offered'
            AND accept_deadline_at IS NOT NULL AND accept_deadline_at <= now()
          ORDER BY id LIMIT 50`
      );
      for (const referral of due.rows) {
        await service.rematchOrExpire(pool, config, referral, deps, 'accept_timeout');
      }
    } catch (err) {
      console.error('[referrals/sweeper] accept-timeout pass error:', err.message);
      if (typeof deps.captureError === 'function') { try { deps.captureError(err, { context: 'sweeper accept' }); } catch (e) { console.error('[referrals/sweeper] captureError failed:', e.message); } }
    }

    // (b) any non-terminal referral past expires_at -> expired + status sync.
    try {
      const expired = await pool.query(
        `UPDATE network_referrals SET status = 'expired', updated_at = now()
          WHERE expires_at IS NOT NULL AND expires_at <= now()
            AND status IN ('offered','accepted')
          RETURNING id, network_ref_id, direction, source_platform, target_platform`
      );
      for (const referral of expired.rows) {
        await service.recordEvent(pool, referral.id, 'expired', { cause: 'ttl' });
        await enqueuePeerStatus(pool, referral, 'expired');
      }
    } catch (err) {
      console.error('[referrals/sweeper] expiry pass error:', err.message);
      if (typeof deps.captureError === 'function') { try { deps.captureError(err, { context: 'sweeper expiry' }); } catch (e) { console.error('[referrals/sweeper] captureError failed:', e.message); } }
    }

    // (c) earned credits older than 12 months -> expired.
    try {
      await pool.query(
        `UPDATE network_referral_credits SET status = 'expired'
          WHERE status = 'earned' AND created_at < now() - interval '12 months'`
      );
    } catch (err) {
      console.error('[referrals/sweeper] credit-expiry pass error:', err.message);
      if (typeof deps.captureError === 'function') { try { deps.captureError(err, { context: 'sweeper credit' }); } catch (e) { console.error('[referrals/sweeper] captureError failed:', e.message); } }
    }
  });
  console.log('[referrals] sweeper cron started (*/15 * * * *)');
  return task;
}

module.exports = {
  peerOf,
  enqueuePeerStatus,
  deliver,
  flushOutbox,
  startOutboxWorker,
  startSweeper,
};
