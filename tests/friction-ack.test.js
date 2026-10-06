const test = require('node:test');
const assert = require('node:assert');
const { requesterAck, adminAlert, painPointPhrase, requestLocation } = require('../services/friction-ack');

const req = {
  painPoint: 'tax-stress', businessType: 'small_business', urgencyLevel: 'urgent',
  contactInfo: { name: 'Pat Doe', email: 'p@example.org', location: 'Halifax, NS' },
};

test('pain point slug becomes a phrase', () => {
  assert.strictEqual(painPointPhrase('tax-stress'), 'tax');
  assert.strictEqual(painPointPhrase('time-drain'), 'bookkeeping and day-to-day accounting');
  assert.strictEqual(painPointPhrase('general'), null);
});

test('location resolves city and province', () => {
  assert.deepStrictEqual(requestLocation({ location: 'Halifax, NS' }), { city: 'Halifax', province: 'NS', label: 'Halifax, NS' });
  assert.strictEqual(requestLocation({ province: 'Ontario' }).province, 'ON');
  assert.strictEqual(requestLocation({}).label, null);
});

test('zero matches: no next-day promise, points to the CPA register', () => {
  const { subject, body } = requesterAck({ request: req, matchCount: 0 });
  assert.doesNotMatch(body, /1 business day/);
  assert.doesNotMatch(body, /tax-stress/);
  assert.match(body, /about tax\./);
  assert.match(body, /Nova Scotia/);
  assert.match(body, /public register/);
  assert.doesNotMatch(body, /lawyer/i);
  assert.doesNotMatch(subject, /a CPA match in/);
});

test('matches found: keeps the 1 business day introduction', () => {
  const { subject, body } = requesterAck({ request: req, matchCount: 1 });
  assert.match(body, /within 1 business day/);
  assert.strictEqual(subject, "We've got your request — a CPA match in Halifax, NS");
});

test('client-supplied name is escaped', () => {
  const r = { ...req, contactInfo: { ...req.contactInfo, name: '<b>x</b>' } };
  assert.match(requesterAck({ request: r, matchCount: 0 }).body, /Hi &lt;b&gt;x&lt;\/b&gt;,/);
});

test('admin alert flags zero matches and shows the location', () => {
  const zero = adminAlert({ requestId: 'req_1', request: req, matches: [] });
  assert.strictEqual(zero.subject, 'New SME Match Request: Pat Doe (Halifax, NS) — 0 matches, manual intro needed');
  assert.match(zero.body, /Location:<\/strong> Halifax, NS/);
  const two = adminAlert({ requestId: 'req_1', request: req, matches: [
    { name: 'A', specializations: ['tax'], matchScore: 80 }, { name: 'B', specializations: [], matchScore: 70 }] });
  assert.match(two.subject, /— 2 matches$/);
});
