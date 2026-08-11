// POST /api/admin/founder-outreach/send (batch, Monday Cowork hand-off).
// Accepts up to 50 personalized founder emails and sends them through Resend
// after per-item validation, unsubscribe check, 90-day dedupe, and ZeroBounce.
// Auth is a static X-Admin-Token checked against FOUNDER_OUTREACH_TOKEN, not the
// admin JWT, so the scheduled task can call it without a login. server.js mounts
// this route ABOVE the /api/admin umbrella on purpose; this handler is the only
// auth gate on the path.
//
// dryRun defaults to TRUE. Sending requires an explicit dryRun: false.
//
// Suppression (outreach_unsubscribes) and dedupe (founder_outreach_log) run
// against this service's own database. LAW and INV items are therefore only
// fully gated once this route is deployed on those backends too; until then a
// LAW or INV unsubscribe recorded on its home platform is invisible here.

const crypto = require('crypto');

const MAX_BATCH = 50;
const SEND_SPACING_MS = 2000;
const REPLY_TO = 'arthur@negotiateandwin.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// ZeroBounce verdicts that block a send outright. do_not_mail and catch-all
// proceed (known false-positive class on Canadian corporate domains, see
// services/outreach.js _isHardBlocked).
const ZB_HARD_BLOCK = ['invalid', 'abuse', 'spamtrap'];

const PLATFORMS = {
  ACC: {
    domain: 'canadaaccountants.app',
    fromEnv: 'FOUNDER_FROM_ACC',
    unsubBase: () => process.env.BACKEND_URL || 'https://canadaaccountants-backend-production-1d8f.up.railway.app',
  },
  LAW: {
    domain: 'canadalawyers.app',
    fromEnv: 'FOUNDER_FROM_LAW',
    unsubBase: () => process.env.LAW_BACKEND_URL || null,
  },
  INV: {
    domain: 'canadainvesting.app',
    fromEnv: 'FOUNDER_FROM_INV',
    unsubBase: () => process.env.INV_BACKEND_URL || null,
  },
};

// Hash both sides so timingSafeEqual gets equal-length buffers and the
// comparison stays constant-time regardless of supplied length.
function tokenMatches(supplied, expected) {
  const a = crypto.createHash('sha256').update(String(supplied || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Returns a reason string when the item is malformed, null when it is clean.
function validateItem(item) {
  if (!item || typeof item !== 'object') return 'item is not an object';
  if (!PLATFORMS[item.platform]) return `unknown platform "${item.platform}" (expected ACC, LAW, or INV)`;
  if (typeof item.to !== 'string' || !EMAIL_RE.test(item.to.trim())) return 'malformed to address';
  if (typeof item.subject !== 'string' || !item.subject.trim()) return 'empty subject';
  if (typeof item.body !== 'string' || !item.body.trim()) return 'empty body';
  return null;
}

// Two-line footer: mailing identification + unsubscribe wired to the platform's
// email-keyed /api/unsubscribe route. Returns null when no base URL is known.
function buildFooter(platformCode, email) {
  const base = PLATFORMS[platformCode].unsubBase();
  if (!base) return null;
  const domain = PLATFORMS[platformCode].domain;
  return `\n\nArthur Kostaras, ${domain}\nUnsubscribe: ${base.replace(/\/$/, '')}/api/unsubscribe?email=${encodeURIComponent(email)}`;
}

function fromAddress(platformCode) {
  const p = PLATFORMS[platformCode];
  return process.env[p.fromEnv] || `Arthur Kostaras <founder@${p.domain}>`;
}

// deps: { pool | getPool, sendEmail, getOutreachEngine, sleep }
// getPool and getOutreachEngine are thunks because server.js constructs the pg
// pool and the engine after it mounts this route; both resolve per request,
// safely after startup. sleep is injectable for tests.
function createFounderOutreachSendHandler(deps) {
  const { sendEmail, getOutreachEngine } = deps;
  const wait = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  return async function founderOutreachSendHandler(req, res) {
    try {
      const pool = deps.getPool ? deps.getPool() : deps.pool;
      const expected = process.env.FOUNDER_OUTREACH_TOKEN;
      if (!expected) {
        console.error('[FounderOutreachSend] FOUNDER_OUTREACH_TOKEN not set in this environment; refusing request');
        return res.status(503).json({ error: 'FOUNDER_OUTREACH_TOKEN not configured' });
      }
      if (!tokenMatches(req.headers['x-admin-token'], expected)) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      const body = req.body || {};
      const dryRun = body.dryRun !== false;
      const emails = body.emails;
      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: 'emails must be a non-empty array' });
      }
      if (emails.length > MAX_BATCH) {
        return res.status(422).json({ error: `batch cap is ${MAX_BATCH} items, got ${emails.length}` });
      }

      // ZeroBounce is best-effort: validate when credits exist, never block the
      // batch when the service is unavailable.
      const engine = getOutreachEngine ? getOutreachEngine() : null;
      let zbAvailable = false;
      if (engine && process.env.ZEROBOUNCE_API_KEY) {
        try {
          const credits = await engine._checkZeroBounceCredits();
          zbAvailable = !!(credits && credits.available);
        } catch (err) {
          console.error('[FounderOutreachSend] ZB credit check failed, proceeding without validation:', err.message);
        }
      }

      const skipped = [];
      const failed = [];
      const toSend = [];
      const seenInBatch = new Set();

      for (const item of emails) {
        const reason = validateItem(item);
        if (reason) {
          failed.push({ to: (item && item.to) || null, reason: `invalid: ${reason}` });
          continue;
        }
        const to = item.to.trim();
        const key = to.toLowerCase();

        // Same address twice in one batch: only the first can send. In live mode
        // the log row would catch it, but dry run writes no rows, so an explicit
        // in-batch guard keeps both modes consistent.
        if (seenInBatch.has(key)) {
          skipped.push({ to, reason: 'skipped_deduped' });
          continue;
        }
        seenInBatch.add(key);

        // Hard CASL gate: never send to an unsubscribed address.
        const unsub = await pool.query(
          'SELECT 1 FROM outreach_unsubscribes WHERE LOWER(email) = $1 LIMIT 1',
          [key]
        );
        if (unsub.rows.length > 0) {
          skipped.push({ to, reason: 'skipped_unsubscribed' });
          continue;
        }

        // 90-day dedupe against the same log the digest cron reads.
        const recent = await pool.query(
          `SELECT 1 FROM founder_outreach_log WHERE LOWER(recipient_email) = $1 AND sent_at > NOW() - INTERVAL '90 days' LIMIT 1`,
          [key]
        );
        if (recent.rows.length > 0) {
          skipped.push({ to, reason: 'skipped_deduped' });
          continue;
        }

        if (zbAvailable) {
          try {
            const v = await engine._validateEmail(to);
            const status = ((v && v.status) || '').toLowerCase();
            const sub = ((v && v.sub_status) || '').toLowerCase();
            if (ZB_HARD_BLOCK.includes(status) || sub === 'abuse') {
              skipped.push({ to, reason: `skipped_zb_${status}` });
              continue;
            }
            if (status === 'error' || status === 'validation_unavailable') {
              console.log(`[FounderOutreachSend] zb_unavailable for ${to}, proceeding`);
            }
          } catch (err) {
            console.error(`[FounderOutreachSend] zb_unavailable for ${to}, proceeding:`, err.message);
          }
        } else {
          console.log(`[FounderOutreachSend] zb_unavailable (no credits or no key) for ${to}, proceeding`);
        }

        // Supplied copy ships as-is; the footer is appended only when the body
        // has no unsubscribe line of its own.
        let text = item.body;
        if (!/unsubscribe/i.test(text)) {
          const footer = buildFooter(item.platform, to);
          if (!footer) {
            failed.push({ to, reason: `invalid: no unsubscribe base URL for ${item.platform} (set ${item.platform}_BACKEND_URL)` });
            continue;
          }
          text = text.replace(/\s+$/, '') + footer;
        }

        toSend.push({
          to,
          platform: item.platform,
          candidateName: item.candidateName || null,
          subject: item.subject.trim(),
          text,
          from: fromAddress(item.platform),
        });
      }

      let sent = 0;
      const wouldSend = toSend.map((s) => s.to);

      if (!dryRun) {
        for (let i = 0; i < toSend.length; i++) {
          const s = toSend[i];
          if (i > 0) await wait(SEND_SPACING_MS);
          try {
            const result = await sendEmail({
              to: s.to,
              subject: s.subject,
              text: s.text,
              from: s.from,
              replyTo: REPLY_TO,
            });
            if (result && result.success !== false && result.id) {
              await pool.query(
                `INSERT INTO founder_outreach_log (recipient_email, recipient_name, platform, resend_id, subject, status)
                 VALUES ($1, $2, $3, $4, $5, 'sent')`,
                [s.to, s.candidateName, s.platform, result.id, s.subject]
              );
              sent++;
            } else {
              const why = (result && (result.reason || JSON.stringify(result.error))) || 'no result';
              console.error(`[FounderOutreachSend] send failed for ${s.to}: ${why}`);
              failed.push({ to: s.to, reason: `resend_error: ${why}` });
            }
          } catch (err) {
            console.error(`[FounderOutreachSend] send exception for ${s.to}:`, err.message);
            failed.push({ to: s.to, reason: `resend_error: ${err.message}` });
          }
        }
      }

      const summary = { requested: emails.length, sent, skipped, failed, dryRun };
      if (dryRun) summary.wouldSend = wouldSend;
      console.log(
        `[FounderOutreachSend] ${dryRun ? 'DRY RUN' : 'LIVE'}: requested=${emails.length} ` +
        `${dryRun ? `wouldSend=${wouldSend.length}` : `sent=${sent}`} skipped=${skipped.length} failed=${failed.length}`
      );
      return res.json(summary);
    } catch (err) {
      console.error('[FounderOutreachSend] handler error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  };
}

module.exports = { createFounderOutreachSendHandler, tokenMatches, validateItem, buildFooter, MAX_BATCH };
