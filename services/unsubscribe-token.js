// Stateless HMAC-based unsubscribe tokens for v2 supply sequence.
//
// Token format: /api/u/<emailB64url>/<hmacHex>
// where emailB64url = base64url(email.toLowerCase()) and hmacHex is the
// hex-encoded HMAC-SHA256(UNSUBSCRIBE_SECRET, emailLower).
//
// Stateless: no DB lookup needed to verify. The endpoint reconstructs the
// expected HMAC from the supplied email and compares constant-time.
//
// Rotation: tokens are always issued with UNSUBSCRIBE_SECRET. Verification
// also accepts UNSUBSCRIBE_SECRET_PREVIOUS when it is set, so links in mail
// sent before a rotation keep working (CASL s.11(3): the unsubscribe
// mechanism must stay valid for at least 60 days after sending). Remove
// _PREVIOUS 60 days after the rotation; see OPERATIONS.md.

const crypto = require('crypto');

function _secret() {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (!s || s.length < 16) {
    throw new Error('UNSUBSCRIBE_SECRET must be set (>=16 chars) before issuing unsubscribe tokens');
  }
  return s;
}

// Secrets accepted for verification, current first. A missing, short or
// duplicate _PREVIOUS is ignored.
function _verifySecrets() {
  const current = _secret();
  const prev = process.env.UNSUBSCRIBE_SECRET_PREVIOUS;
  return prev && prev.length >= 16 && prev !== current ? [current, prev] : [current];
}

function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64urlDecode(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function _hmac(email, secret = _secret()) {
  return crypto.createHmac('sha256', secret).update(email.toLowerCase()).digest('hex');
}

function makeUrl(email, baseUrl) {
  if (!email) return '';
  const lower = email.toLowerCase().trim();
  const eb64 = _b64url(lower);
  const sig = _hmac(lower);
  const base = (baseUrl || process.env.BACKEND_PUBLIC_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'canadaaccountants-backend-production-1d8f.up.railway.app'}`).replace(/\/$/, '');
  return `${base}/api/u/${eb64}/${sig}`;
}

function verify(emailB64, sig) {
  let email;
  try {
    email = _b64urlDecode(emailB64).toLowerCase();
  } catch (_) {
    return null;
  }
  if (!email || !sig || !/^[0-9a-f]{64}$/i.test(String(sig))) return null;
  let secrets;
  try {
    secrets = _verifySecrets();
  } catch (_) {
    return null;
  }
  const given = Buffer.from(String(sig), 'hex');
  for (const secret of secrets) {
    const expected = Buffer.from(_hmac(email, secret), 'hex');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return email;
  }
  return null;
}

module.exports = { makeUrl, verify };
