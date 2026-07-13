// Dark-behavior proof for the webinar-invite message class.
// The class must be inert with both flags off, must never write an evidence row
// without a real send id, and must refuse unresolved placeholders.
const test = require('node:test');
const assert = require('node:assert');
const { renderWebinarInvite, sendWebinarInvites } = require('../services/webinar-invite');

const OPTS = { dateLine: 'Thursday, September 10 at 12:00 ET', registrationUrl: 'https://example.test/register' };

function mockPool() {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO webinar_invite_log/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] }); // suppression lookup: not suppressed
    },
  };
}

test('render resolves placeholders and hashes the template', () => {
  const r = renderWebinarInvite({ firstName: 'Dana', ...OPTS });
  assert.match(r.text, /Hi Dana,/);
  assert.match(r.text, /Thursday, September 10 at 12:00 ET/);
  assert.match(r.html, /https:\/\/example\.test\/register/);
  assert.strictEqual(r.templateHash.length, 12);
  assert.strictEqual(r.templateHash, renderWebinarInvite({ firstName: 'Dana', ...OPTS }).templateHash);
});

test('render refuses unresolved placeholders', () => {
  assert.throws(() => renderWebinarInvite({ firstName: 'Dana', dateLine: '', registrationUrl: 'x' }), /unresolved placeholder/);
  assert.throws(() => renderWebinarInvite({ firstName: 'Dana', dateLine: 'x', registrationUrl: null }), /unresolved placeholder/);
});

test('flag off: dry run only, zero sends, zero evidence rows', async () => {
  delete process.env.WEBINAR_INVITE_ENABLED;
  delete process.env.WEBINAR_INVITE_ALLOW_THIRD_PARTY;
  const pool = mockPool();
  const results = await sendWebinarInvites(pool, {
    cohort: [
      { email: 'real.person@example-firm.ca', first_name: 'Real', casl_basis: 'ebr', evidence_ref: 'subscription row 1' },
      { email: 'arthur+selftest@negotiateandwin.com', first_name: 'Arthur', casl_basis: 'express', evidence_ref: 'consent row 1' },
    ],
    ...OPTS,
  });
  assert.strictEqual(results.dryRun, true);
  assert.strictEqual(results.sent, 0);
  assert.strictEqual(results.wouldSend, 2);
  assert.ok(!pool.calls.some(c => /INSERT INTO webinar_invite_log/.test(c.sql)), 'no evidence row on dry run');
});

test('missing basis or evidence skips loud', async () => {
  delete process.env.WEBINAR_INVITE_ENABLED;
  const pool = mockPool();
  const results = await sendWebinarInvites(pool, {
    cohort: [{ email: 'x@example-firm.ca', first_name: 'X', casl_basis: 'implied', evidence_ref: 'n/a' }],
    ...OPTS,
  });
  assert.strictEqual(results.wouldSend, 0);
  assert.deepStrictEqual(results.skipped[0], { email: 'x@example-firm.ca', reason: 'invalid_basis_or_evidence' });
});

test('sends on, third-party off: real professional blocks, no evidence row without a send id', async () => {
  process.env.WEBINAR_INVITE_ENABLED = 'true';
  delete process.env.WEBINAR_INVITE_ALLOW_THIRD_PARTY;
  delete process.env.RESEND_API_KEY; // self-test path falls to api_key_missing, so no id, so no row
  const pool = mockPool();
  const results = await sendWebinarInvites(pool, {
    cohort: [
      { email: 'real.person@example-firm.ca', first_name: 'Real', casl_basis: 'ebr', evidence_ref: 'subscription row 1' },
      { email: 'arthur+selftest@negotiateandwin.com', first_name: 'Arthur', casl_basis: 'express', evidence_ref: 'consent row 1' },
    ],
    ...OPTS,
  });
  delete process.env.WEBINAR_INVITE_ENABLED;
  assert.strictEqual(results.sent, 0);
  assert.ok(results.skipped.some(s => s.reason === 'third_party_blocked'), 'real professional blocked by moratorium belt');
  assert.ok(results.failed.some(f => f.reason === 'api_key_missing'), 'self-test address reached the send layer only');
  assert.ok(!pool.calls.some(c => /INSERT INTO webinar_invite_log/.test(c.sql)), 'no evidence row without a Resend id');
});
