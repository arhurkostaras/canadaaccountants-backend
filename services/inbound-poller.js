// Inbound mail polling cron (Section 4.0 of campaign brief v1.7).
// Polls arthur@negotiateandwin.com (Google Workspace) every 5 minutes via IMAP,
// extracts platform from Delivered-To / X-Forwarded-To / X-Original-To / To headers,
// and dispatches each message to the right backend's /api/inbound endpoint.
//
// All four platforms' inbound replies already aggregate into this one mailbox via
// existing forwarding rules (Cloudflare Email Routing for ACC + CBE; Porkbun for
// LAW + INV). No DNS changes required.
//
// Failure mode: if any step fails, the message stays UNSEEN in the mailbox and the
// next poll cycle retries. consecutive_failures counter tracks streaks; after 3
// consecutive failures, an alert email goes to Arthur.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');

// Map original recipient address → platform key + backend URL env var name.
// ACC self-dispatch: prefer ACC_BACKEND_URL if set, else derive from Railway's
// auto-injected RAILWAY_PUBLIC_DOMAIN, else localhost on the server's PORT.
const _selfUrl = process.env.ACC_BACKEND_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
  || `http://localhost:${process.env.PORT || 8080}`;

const PLATFORM_ROUTING = {
  'arthur@canadaaccountants.app': { platform: 'acc', backendUrl: _selfUrl },
  'arthur@canadalawyers.app':     { platform: 'law', backendUrl: process.env.LAW_BACKEND_URL },
  'arthur@canadainvesting.app':   { platform: 'inv', backendUrl: process.env.INV_BACKEND_URL },
  'arthur@canadabusinessexits.app': { platform: 'cbe', backendUrl: process.env.CBE_BACKEND_URL }
};

// Header preference order for extracting the original recipient before forwarding
const RECIPIENT_HEADER_ORDER = ['delivered-to', 'x-forwarded-to', 'x-original-to', 'to'];

function _normalizeAddress(value) {
  if (!value) return null;
  // Mail-parser returns Address objects with .text (display) or .value (parsed array)
  if (typeof value === 'string') {
    const m = value.match(/<([^>]+)>/);
    return (m ? m[1] : value).toLowerCase().trim();
  }
  if (value.value && Array.isArray(value.value) && value.value.length > 0) {
    return (value.value[0].address || '').toLowerCase().trim();
  }
  if (value.text) {
    return _normalizeAddress(value.text);
  }
  return null;
}

function _resolvePlatform(parsed) {
  // mailparser-normalized headers live on parsed.headers (a Map). Raw headers on
  // parsed.headerLines. Try the preference order, then the To header as last resort.
  for (const headerName of RECIPIENT_HEADER_ORDER) {
    const raw = parsed.headers.get(headerName);
    const normalized = _normalizeAddress(raw);
    if (normalized && PLATFORM_ROUTING[normalized]) {
      return { recipient: normalized, ...PLATFORM_ROUTING[normalized] };
    }
  }
  return null;
}

function _hmacSign(secret, ts, payload) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
}

async function _dispatchToBackend(route, messagePayload) {
  if (!route.backendUrl) {
    throw new Error(`backend URL not configured for platform ${route.platform}`);
  }
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('INBOUND_WEBHOOK_SECRET not configured');
  }
  const body = JSON.stringify(messagePayload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = _hmacSign(secret, ts, body);
  const url = `${route.backendUrl.replace(/\/$/, '')}/api/inbound`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Inbound-Timestamp': ts,
        'X-Inbound-Signature': sig
      },
      body
    });
  } catch (fetchErr) {
    const cause = fetchErr.cause ? ` (cause: ${fetchErr.cause.message || fetchErr.cause})` : '';
    throw new Error(`fetch to ${url} failed: ${fetchErr.message}${cause}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`backend ${route.platform} at ${url} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

// Custom IMAP keyword the poller uses to track its own processing state,
// independent of \Seen (which Arthur's normal inbox reading also toggles).
// Without this, auto-replies that Arthur reads before the next poll cycle
// (mobile notification, desktop preview) become invisible to the poller
// because \Seen is already true. With this keyword, we track dispatch state
// in a poller-owned namespace.
const POLLER_KEYWORD = 'PlatformInboundDispatched';

async function _processMessage(client, uid, parsed, flags) {
  if (flags && flags.has(POLLER_KEYWORD)) {
    // Already dispatched by a prior poll cycle. Skip.
    return { skipped: true, reason: 'already dispatched' };
  }
  const route = _resolvePlatform(parsed);
  if (!route) {
    // Mail not addressed to any of the four platform reply-tos — leave it alone.
    // This is Arthur's personal inbox traffic. We do not mark with our keyword
    // so the cost of re-checking on every poll is a single header parse.
    return { skipped: true, reason: 'not platform mail' };
  }
  const messageId = parsed.messageId || `synthetic-${parsed.from?.value?.[0]?.address || 'unknown'}-${parsed.date?.toISOString() || Date.now()}-${uid}`;
  const payload = {
    from_email: _normalizeAddress(parsed.from) || 'unknown@unknown',
    to_email: route.recipient,
    subject: parsed.subject || null,
    body_text: parsed.text || '',
    body_html: parsed.html || null,
    message_id: messageId,
    received_at: (parsed.date || new Date()).toISOString()
  };
  await _dispatchToBackend(route, payload);
  // Mark our custom keyword (and \Seen as a courtesy) only after successful
  // dispatch so failures retry on the next poll. The keyword is what gates
  // duplicate dispatch; \Seen is independent and may already be true if
  // Arthur read the message before this poll cycle ran.
  await client.messageFlagsAdd({ uid }, ['\\Seen', POLLER_KEYWORD], { uid: true });
  return { dispatched: true, platform: route.platform, message_id: messageId };
}

async function pollOnce(pool) {
  const startedAt = new Date();
  const appPassword = process.env.GMAIL_IMAP_APP_PASSWORD;
  const mailboxUser = process.env.GMAIL_IMAP_USER || 'arthur@negotiateandwin.com';
  if (!appPassword) {
    const err = new Error('GMAIL_IMAP_APP_PASSWORD not configured');
    await _writeStatus(pool, { status: 'failed', error: err.message, count: 0, increment_failures: true });
    console.error('[InboundPoller] aborting:', err.message);
    return { ok: false, error: err.message };
  }
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: mailboxUser, pass: appPassword },
    logger: false
  });
  let dispatched = 0;
  let skipped = 0;
  let errored = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search by date only, no unseen filter. Arthur's read state on his
      // own inbox is orthogonal to whether our poller has dispatched the
      // message. The POLLER_KEYWORD on each message is what gates duplicate
      // dispatch — see _processMessage.
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7d window
      const uids = await client.search({ since }, { uid: true });
      for (const uid of uids) {
        try {
          const downloaded = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
          if (!downloaded?.source) {
            errored++;
            console.error(`[InboundPoller] uid ${uid}: no source`);
            continue;
          }
          const parsed = await simpleParser(downloaded.source);
          const result = await _processMessage(client, uid, parsed, downloaded.flags);
          if (result.skipped) skipped++;
          else if (result.dispatched) dispatched++;
        } catch (perMsgErr) {
          errored++;
          console.error(`[InboundPoller] uid ${uid} processing error:`, perMsgErr.message);
          // Leave UNSEEN; next poll retries.
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    const ok = errored === 0;
    await _writeStatus(pool, {
      status: ok ? 'ok' : 'partial',
      error: ok ? null : `${errored} message(s) errored this poll`,
      count: dispatched,
      increment_failures: !ok && dispatched === 0
    });
    console.log(`[InboundPoller] ${startedAt.toISOString()}: dispatched=${dispatched} skipped=${skipped} errored=${errored}`);
    return { ok, dispatched, skipped, errored };
  } catch (connErr) {
    console.error('[InboundPoller] connection or fetch error:', connErr.message);
    try { await client.logout(); } catch (_) { /* socket already dead */ }
    await _writeStatus(pool, { status: 'failed', error: connErr.message, count: 0, increment_failures: true });
    await _maybeAlert(pool, connErr.message);
    return { ok: false, error: connErr.message };
  }
}

async function _writeStatus(pool, { status, error, count, increment_failures }) {
  try {
    if (increment_failures) {
      await pool.query(
        `UPDATE inbound_poll_status
         SET last_poll_at = NOW(), last_poll_status = $1, last_poll_message_count = $2,
             last_poll_error = $3, consecutive_failures = consecutive_failures + 1, updated_at = NOW()
         WHERE id = 1`,
        [status, count, error]
      );
    } else {
      await pool.query(
        `UPDATE inbound_poll_status
         SET last_poll_at = NOW(), last_poll_status = $1, last_poll_message_count = $2,
             last_poll_error = $3, consecutive_failures = 0, updated_at = NOW()
         WHERE id = 1`,
        [status, count, error]
      );
    }
  } catch (dbErr) {
    console.error('[InboundPoller] status write failed:', dbErr.message);
  }
}

async function _maybeAlert(pool, errorMessage) {
  try {
    const r = await pool.query(`SELECT consecutive_failures FROM inbound_poll_status WHERE id = 1`);
    const failures = r.rows[0]?.consecutive_failures || 0;
    if (failures !== 3) return; // alert exactly once on the 3rd failure; not on 4+
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'noreply@canadaaccountants.app',
      to: 'arthur@negotiateandwin.com',
      subject: '[INBOUND-POLLER] 3 consecutive failures',
      text: `The inbound mail polling cron has failed 3 times in a row.\n\nLatest error: ${errorMessage}\n\nCheck /api/admin/inbound-health for current state. Polling will keep retrying every 5 minutes; alerts will not repeat until consecutive_failures resets to 0.`
    });
  } catch (alertErr) {
    console.error('[InboundPoller] alert send failed:', alertErr.message);
  }
}

module.exports = { pollOnce };
