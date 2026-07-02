// modules/referrals/hmac.js
// Server-to-server HMAC, byte-for-byte the same scheme as server.js
// _verifyInboundSignature so operators reason about one contract, not two:
//
//   canonical = `${timestamp}.${payload}`
//     - POST: payload = raw request body (exact bytes)
//     - GET : payload = `${METHOD} ${path}?${query}`  (no body)
//   signature = hex(HMAC_SHA256(secret, canonical))
//   headers   = X-Network-Timestamp (unix seconds), X-Network-Signature (hex),
//               X-Network-Platform (sender id)
//   freshness = |now - ts| must be <= 300s
//
// Verify accepts either the primary secret or NETWORK_SHARED_SECRET_NEXT so the
// rotation runbook (spec section 14) can flip secrets with zero downtime.

'use strict';

const crypto = require('crypto');

const MAX_SKEW_SECONDS = 300;

function sign(secret, timestamp, payload) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

function timingSafeHexEqual(a, b) {
  let aBuf;
  let bBuf;
  try {
    aBuf = Buffer.from(a, 'hex');
    bBuf = Buffer.from(b, 'hex');
  } catch (err) {
    return false;
  }
  if (aBuf.length !== bBuf.length || aBuf.length === 0) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Verify a signature against every configured secret (primary + rotation).
// Returns { ok, reason }. Never throws.
function verify({ secrets, timestamp, signature, canonicalPayload }) {
  const activeSecrets = (secrets || []).filter(Boolean);
  if (activeSecrets.length === 0) return { ok: false, reason: 'NETWORK_SHARED_SECRET not configured' };
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };

  const skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'stale or invalid timestamp' };
  }

  for (const secret of activeSecrets) {
    const expected = sign(secret, timestamp, canonicalPayload);
    if (timingSafeHexEqual(signature, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature mismatch' };
}

// Canonical payload for a GET request: `${METHOD} ${path}?${query}`.
function canonicalForGet(method, path, query) {
  return query ? `${method} ${path}?${query}` : `${method} ${path}`;
}

module.exports = { sign, verify, canonicalForGet, MAX_SKEW_SECONDS };
