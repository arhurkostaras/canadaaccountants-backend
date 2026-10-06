// Opening an emailed checkout link (GET) never creates a Stripe session; only
// the button on the page (POST) does, so mail scanners that GET every link in a
// message cannot create sessions that read as buyer interest.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('GET /api/checkout/:tier renders a page and creates no Stripe session', () => {
  const start = src.indexOf("app.get('/api/checkout/:tier'");
  const end = src.indexOf("app.post('/api/checkout/:tier'");
  assert.ok(start > 0 && end > start, 'GET handler precedes the POST handler');
  const getHandler = src.slice(start, end);
  assert.doesNotMatch(getHandler, /checkout\.sessions\.create/);
  assert.match(getHandler, /checkoutPage\(tier, params\)/);
  const postHandler = src.slice(end, src.indexOf("app.get('/api/stripe/subscription-status'"));
  assert.match(postHandler, /express\.urlencoded/);
  assert.match(postHandler, /checkout\.sessions\.create/);
  assert.match(postHandler, /res\.redirect\(303, session\.url\)/);
});

test('the checkout page escapes what it echoes and posts back to itself', () => {
  const page = src.slice(src.indexOf('function checkoutPage('), src.indexOf("app.get('/api/checkout/:tier'"));
  assert.match(page, /<form method="POST" action="\/api\/checkout\/\$\{encodeURIComponent\(tier\)\}">/);
  for (const f of ['email', 'name', 'appId']) assert.match(page, new RegExp(`checkoutEscape\\(${f}\\)`), f);
});
