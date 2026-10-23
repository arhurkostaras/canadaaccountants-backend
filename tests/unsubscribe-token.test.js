// Unsubscribe token rotation: tokens are issued with UNSUBSCRIBE_SECRET and
// verified against it, then UNSUBSCRIBE_SECRET_PREVIOUS (CASL 60-day overlap).

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const tok = require('../services/unsubscribe-token');

const OLD = 'old-secret-0123456789abcdef';
const NEW = 'new-secret-fedcba9876543210';
const EMAIL = 'Someone@Example.com';
const saved = { s: process.env.UNSUBSCRIBE_SECRET, p: process.env.UNSUBSCRIBE_SECRET_PREVIOUS };

function setEnv(secret, previous) {
  if (secret === undefined) delete process.env.UNSUBSCRIBE_SECRET;
  else process.env.UNSUBSCRIBE_SECRET = secret;
  if (previous === undefined) delete process.env.UNSUBSCRIBE_SECRET_PREVIOUS;
  else process.env.UNSUBSCRIBE_SECRET_PREVIOUS = previous;
}

function parts(url) {
  const m = /\/api\/u\/([^/]+)\/([0-9a-f]+)$/.exec(url);
  assert.ok(m, `unexpected url shape: ${url}`);
  return [m[1], m[2]];
}

beforeEach(() => setEnv(undefined, undefined));
after(() => setEnv(saved.s, saved.p));

test('round trip with a single secret (no behaviour change when _PREVIOUS unset)', () => {
  setEnv(OLD);
  const [e, s] = parts(tok.makeUrl(EMAIL, 'https://x.test'));
  assert.strictEqual(tok.verify(e, s), 'someone@example.com');
});

test('link issued before rotation verifies via _PREVIOUS', () => {
  setEnv(OLD);
  const [e, s] = parts(tok.makeUrl(EMAIL, 'https://x.test'));
  setEnv(NEW, OLD);
  assert.strictEqual(tok.verify(e, s), 'someone@example.com');
});

test('link issued before rotation fails once _PREVIOUS is removed', () => {
  setEnv(OLD);
  const [e, s] = parts(tok.makeUrl(EMAIL, 'https://x.test'));
  setEnv(NEW);
  assert.strictEqual(tok.verify(e, s), null);
});

test('new links are issued with the current secret, not _PREVIOUS', () => {
  setEnv(NEW, OLD);
  const [e, s] = parts(tok.makeUrl(EMAIL, 'https://x.test'));
  setEnv(NEW);
  assert.strictEqual(tok.verify(e, s), 'someone@example.com');
  setEnv(OLD);
  assert.strictEqual(tok.verify(e, s), null);
});

test('a short _PREVIOUS is ignored', () => {
  setEnv('short');
  // cannot issue with a short secret; sign directly with the short value
  const crypto = require('crypto');
  const email = 'someone@example.com';
  const e = Buffer.from(email).toString('base64').replace(/=+$/, '');
  const s = crypto.createHmac('sha256', 'short').update(email).digest('hex');
  setEnv(NEW, 'short');
  assert.strictEqual(tok.verify(e, s), null);
});

test('tampered, non-hex and empty signatures return null without throwing', () => {
  setEnv(NEW, OLD);
  const [e, s] = parts(tok.makeUrl(EMAIL, 'https://x.test'));
  const flipped = (s[0] === 'a' ? 'b' : 'a') + s.slice(1);
  assert.strictEqual(tok.verify(e, flipped), null);
  assert.strictEqual(tok.verify(e, 'z'.repeat(64)), null);
  assert.strictEqual(tok.verify(e, s.slice(0, 63)), null);
  assert.strictEqual(tok.verify(e, s + 'f'), null);
  assert.strictEqual(tok.verify(e, s.toUpperCase()), 'someone@example.com');
  assert.strictEqual(tok.verify(e, ''), null);
});

test('verify returns null when no secret is configured', () => {
  setEnv(OLD);
  const [e, s] = parts(tok.makeUrl(EMAIL, 'https://x.test'));
  setEnv(undefined, OLD);
  assert.strictEqual(tok.verify(e, s), null);
});
