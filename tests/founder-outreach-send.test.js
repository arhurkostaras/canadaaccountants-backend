// Behavior proof for the founder-outreach batch send endpoint.
// Covers acceptance tests that need no live infrastructure: auth (401/503),
// dry-run classification with zero sends and zero log writes, the 50-item
// batch cap (422), dedupe, footer handling, and the live send path against
// mocked Resend and pg.
const test = require('node:test');
const assert = require('node:assert');
const { createFounderOutreachSendHandler, validateItem, buildFooter } = require('../routes/founder-outreach-send');

const TOKEN = 'test-token-abc123';

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  return res;
}

function mockReq({ token, body } = {}) {
  return { headers: token ? { 'x-admin-token': token } : {}, body };
}

// pool mock: routes queries on table name. unsubscribed and recentlySent are
// arrays of lowercase addresses; inserts are recorded.
function mockPool({ unsubscribed = [], recentlySent = [] } = {}) {
  const inserts = [];
  return {
    inserts,
    query(sql, params) {
      if (/INSERT INTO founder_outreach_log/.test(sql)) {
        inserts.push(params);
        return Promise.resolve({ rows: [] });
      }
      if (/outreach_unsubscribes/.test(sql)) {
        return Promise.resolve({ rows: unsubscribed.includes(params[0]) ? [{ '?column?': 1 }] : [] });
      }
      if (/founder_outreach_log/.test(sql)) {
        return Promise.resolve({ rows: recentlySent.includes(params[0]) ? [{ '?column?': 1 }] : [] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

function mockSendEmail() {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    return Promise.resolve({ success: true, id: `resend-${calls.length}` });
  };
  fn.calls = calls;
  return fn;
}

function item(overrides = {}) {
  return {
    platform: 'ACC',
    to: 'clean@example-firm.ca',
    candidateName: 'Clean Person',
    subject: 'A personal note',
    body: 'Hi there, this is a personal founder note.',
    ...overrides,
  };
}

function handlerWith({ pool, sendEmail } = {}) {
  return createFounderOutreachSendHandler({
    getPool: () => pool || mockPool(),
    sendEmail: sendEmail || mockSendEmail(),
    getOutreachEngine: () => null,
    sleep: () => Promise.resolve(),
  });
}

test.beforeEach(() => {
  process.env.FOUNDER_OUTREACH_TOKEN = TOKEN;
  delete process.env.ZEROBOUNCE_API_KEY;
});

test('missing token gets 401, wrong token gets 401, no detail leaked', async () => {
  const handler = handlerWith({});
  for (const token of [undefined, 'wrong-token']) {
    const res = mockRes();
    await handler(mockReq({ token, body: { emails: [item()] } }), res);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: 'unauthorized' });
  }
});

test('unset FOUNDER_OUTREACH_TOKEN refuses with 503, never treats empty as a match', async () => {
  delete process.env.FOUNDER_OUTREACH_TOKEN;
  const handler = handlerWith({});
  const res = mockRes();
  await handler(mockReq({ token: '', body: { emails: [item()] } }), res);
  assert.strictEqual(res.statusCode, 503);
});

test('batch of 51 gets 422', async () => {
  const emails = Array.from({ length: 51 }, (_, i) => item({ to: `p${i}@example-firm.ca` }));
  const res = mockRes();
  await handlerWith({})(mockReq({ token: TOKEN, body: { emails } }), res);
  assert.strictEqual(res.statusCode, 422);
});

test('dryRun defaults to true when omitted; zero sends, zero log writes', async () => {
  const pool = mockPool();
  const sendEmail = mockSendEmail();
  const res = mockRes();
  await handlerWith({ pool, sendEmail })(mockReq({ token: TOKEN, body: { emails: [item()] } }), res);
  assert.strictEqual(res.body.dryRun, true);
  assert.strictEqual(res.body.sent, 0);
  assert.deepStrictEqual(res.body.wouldSend, ['clean@example-firm.ca']);
  assert.strictEqual(sendEmail.calls.length, 0);
  assert.strictEqual(pool.inserts.length, 0);
});

test('dry run classifies clean, unsubscribed, deduped, and malformed correctly', async () => {
  const pool = mockPool({
    unsubscribed: ['optout@example-firm.ca'],
    recentlySent: ['recent@example-firm.ca'],
  });
  const sendEmail = mockSendEmail();
  const emails = [
    item(),
    item({ to: 'optout@example-firm.ca' }),
    item({ to: 'recent@example-firm.ca' }),
    item({ to: 'not-an-email' }),
    item({ platform: 'XXX', to: 'x@example-firm.ca' }),
  ];
  const res = mockRes();
  await handlerWith({ pool, sendEmail })(mockReq({ token: TOKEN, body: { dryRun: true, emails } }), res);
  assert.strictEqual(res.body.requested, 5);
  assert.deepStrictEqual(res.body.wouldSend, ['clean@example-firm.ca']);
  assert.deepStrictEqual(res.body.skipped, [
    { to: 'optout@example-firm.ca', reason: 'skipped_unsubscribed' },
    { to: 'recent@example-firm.ca', reason: 'skipped_deduped' },
  ]);
  assert.strictEqual(res.body.failed.length, 2);
  assert.match(res.body.failed[0].reason, /malformed to address/);
  assert.match(res.body.failed[1].reason, /unknown platform/);
  assert.strictEqual(sendEmail.calls.length, 0);
  assert.strictEqual(pool.inserts.length, 0);
});

test('same address twice in one batch dedupes the second occurrence', async () => {
  const res = mockRes();
  await handlerWith({})(mockReq({ token: TOKEN, body: {
    dryRun: true,
    emails: [item(), item({ candidateName: 'Duplicate' })],
  } }), res);
  assert.strictEqual(res.body.wouldSend.length, 1);
  assert.deepStrictEqual(res.body.skipped, [{ to: 'clean@example-firm.ca', reason: 'skipped_deduped' }]);
});

test('live send: founder@ from, reply-to Arthur, footer appended, log row written', async () => {
  const pool = mockPool();
  const sendEmail = mockSendEmail();
  const res = mockRes();
  await handlerWith({ pool, sendEmail })(mockReq({ token: TOKEN, body: { dryRun: false, emails: [item()] } }), res);
  assert.strictEqual(res.body.dryRun, false);
  assert.strictEqual(res.body.sent, 1);
  assert.strictEqual(sendEmail.calls.length, 1);
  const call = sendEmail.calls[0];
  assert.strictEqual(call.from, 'Arthur Kostaras <founder@canadaaccountants.app>');
  assert.strictEqual(call.replyTo, 'arthur@negotiateandwin.com');
  assert.match(call.text, /Arthur Kostaras, canadaaccountants\.app/);
  assert.match(call.text, /Unsubscribe: .*\/api\/unsubscribe\?email=clean%40example-firm\.ca/);
  assert.strictEqual(pool.inserts.length, 1);
  const [email, name, platform, resendId, subject] = pool.inserts[0];
  assert.strictEqual(email, 'clean@example-firm.ca');
  assert.strictEqual(name, 'Clean Person');
  assert.strictEqual(platform, 'ACC');
  assert.strictEqual(resendId, 'resend-1');
  assert.strictEqual(subject, 'A personal note');
});

test('body that already carries an unsubscribe line is shipped unmodified', async () => {
  const sendEmail = mockSendEmail();
  const body = 'Hi, note.\n\nArthur Kostaras, canadaaccountants.app\nUnsubscribe: https://example.test/u';
  const res = mockRes();
  await handlerWith({ sendEmail })(mockReq({ token: TOKEN, body: {
    dryRun: false,
    emails: [item({ body })],
  } }), res);
  assert.strictEqual(sendEmail.calls[0].text, body);
});

test('resend failure lands the item in failed with the reason, no log row', async () => {
  const pool = mockPool();
  const sendEmail = (args) => Promise.resolve({ success: false, reason: 'api_error', error: { message: 'domain not verified' } });
  const res = mockRes();
  await handlerWith({ pool, sendEmail })(mockReq({ token: TOKEN, body: { dryRun: false, emails: [item()] } }), res);
  assert.strictEqual(res.body.sent, 0);
  assert.strictEqual(res.body.failed.length, 1);
  assert.match(res.body.failed[0].reason, /resend_error: api_error/);
  assert.strictEqual(pool.inserts.length, 0);
});

test('LAW item without LAW_BACKEND_URL fails loud instead of sending without an unsubscribe link', async () => {
  delete process.env.LAW_BACKEND_URL;
  const sendEmail = mockSendEmail();
  const res = mockRes();
  await handlerWith({ sendEmail })(mockReq({ token: TOKEN, body: {
    dryRun: false,
    emails: [item({ platform: 'LAW', to: 'lawyer@example-firm.ca' })],
  } }), res);
  assert.strictEqual(res.body.sent, 0);
  assert.match(res.body.failed[0].reason, /no unsubscribe base URL for LAW/);
  assert.strictEqual(sendEmail.calls.length, 0);
});

test('validateItem catches empty subject and empty body', () => {
  assert.match(validateItem(item({ subject: '  ' })), /empty subject/);
  assert.match(validateItem(item({ body: '' })), /empty body/);
  assert.strictEqual(validateItem(item()), null);
});

test('buildFooter uses LAW_BACKEND_URL when set', () => {
  process.env.LAW_BACKEND_URL = 'https://law.example.test/';
  const footer = buildFooter('LAW', 'a@b.ca');
  assert.match(footer, /canadalawyers\.app/);
  assert.match(footer, /https:\/\/law\.example\.test\/api\/unsubscribe\?email=a%40b\.ca/);
  delete process.env.LAW_BACKEND_URL;
});
