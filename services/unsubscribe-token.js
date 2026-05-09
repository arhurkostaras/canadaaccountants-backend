// Stateless HMAC-based unsubscribe tokens for v2 supply sequence.
//
// Token format: /api/u/<emailB64url>/<hmacHex>
// where emailB64url = base64url(email.toLowerCase()) and hmacHex is the
// hex-encoded HMAC-SHA256(UNSUBSCRIBE_SECRET, emailLower).
//
// Stateless: no DB lookup needed to verify. The endpoint reconstructs the
// expected HMAC from the supplied email and compares constant-time.

const crypto = require('crypto');

function _secret() {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (!s || s.length < 16) {
    throw new Error('UNSUBSCRIBE_SECRET must be set (>=16 chars) before issuing unsubscribe tokens');
  }
  return s;
}

function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64urlDecode(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function _hmac(email) {
  return crypto.createHmac('sha256', _secret()).update(email.toLowerCase()).digest('hex');
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
  if (!email || !sig) return null;
  let expected;
  try {
    expected = _hmac(email);
  } catch (_) {
    return null;
  }
  if (sig.length !== expected.length) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  return ok ? email : null;
}

module.exports = { makeUrl, verify };
