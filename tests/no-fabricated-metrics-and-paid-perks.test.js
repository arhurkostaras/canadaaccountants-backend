// Hotfix guards (2026-10-05).
//
// 1. Nothing shown to a client or a professional may be invented. The retired
//    /api/performance/score returned random "85-99%" scores; the dashboard,
//    the activity digest and the weekly digest padded view counts with
//    Math.random; the weekly digest added a random rank; the competitive report
//    printed "new claims" (population x 3) and a constant "avg. score 50".
// 2. The legacy bulk emails to professionals stay off unless
//    LEGACY_PRO_BLASTS_ENABLED=true (ACC professional-contact moratorium).
// 3. A payer must get their perks, and a canceled member must lose them:
//    the emailed checkout button carried no ids, so payers matched no webhook
//    branch; cancellation only touched cpa_subscriptions.
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function routeBody(signature) {
  const start = SRC.indexOf(signature);
  assert.ok(start >= 0, `route not found: ${signature}`);
  const next = SRC.indexOf('\napp.', start + signature.length);
  return SRC.slice(start, next < 0 ? undefined : next);
}

test('Math.random is used only for ids, never for numbers people see', () => {
  const offenders = SRC.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /Math\.random/.test(line))
    .filter(({ line }) => !/toString\(36\)/.test(line));
  assert.deepStrictEqual(offenders, [], `Math.random outside id generation:\n${offenders.map(o => `${o.n}: ${o.line.trim()}`).join('\n')}`);
});

test('the random performance-score endpoint stays retired', () => {
  const body = routeBody("app.post('/api/performance/score'");
  assert.match(body, /status\(410\)/);
  assert.doesNotMatch(body, /overallScore|clientSatisfaction|successPrediction/);
});

test('no padded or fabricated figures in member-facing copy', () => {
  assert.doesNotMatch(SRC, /Math\.max\(realViews/, 'view counts must not be floored by an estimate');
  assert.doesNotMatch(SRC, /stats\.newClaims|stats\.avgScore/);
  assert.doesNotMatch(SRC, /Your ranking<\/td>/);
  assert.doesNotMatch(SRC, /get 40% more inquiries/);
});

test('legacy bulk emails to professionals are gated by LEGACY_PRO_BLASTS_ENABLED', () => {
  for (const route of ['send-activity-digest', 'send-weekly-digest', 'send-behavioral-sequences', 'send-competitive-report']) {
    const re = new RegExp(`app\\.post\\('/api/admin/${route}',[^\\n]*requireLegacyProBlasts`);
    assert.match(SRC, re, `${route} must use requireLegacyProBlasts`);
  }
  assert.match(SRC, /process\.env\.LEGACY_PRO_BLASTS_ENABLED === 'true'/);
});

test('emailed checkout carries the payer ids and the webhook resolves by email', () => {
  // The session is created by the POST (the GET only renders the scanner-safe page).
  const checkout = routeBody("app.post('/api/checkout/:tier'");
  assert.match(checkout, /resolvePayerByEmail\(email\)/);
  assert.match(checkout, /cpa_profile_id: known\.cpaProfileId/);
  const webhook = routeBody("app.post('/api/stripe/webhook'");
  assert.match(webhook, /resolvePayerByEmail\(payerEmail\)/);
  assert.match(webhook, /UNMATCHED PAYMENT/, 'an unmatched payment must alert, not vanish');
  assert.match(webhook, /upsertCpaSubscription\(profileId, session, appTier\)/, 'paying applicants get a subscription row');
});

test('cancellation removes perks from every table a gate reads', () => {
  const webhook = routeBody("app.post('/api/stripe/webhook'");
  const deleted = webhook.slice(webhook.indexOf("case 'customer.subscription.deleted'"));
  assert.match(deleted.slice(0, 600), /syncPerksForSubscription\(sub\.id, sub\.customer, false\)/);
  const helper = SRC.slice(SRC.indexOf('async function syncPerksForSubscription'), SRC.indexOf("app.post('/api/stripe/webhook'"));
  assert.match(helper, /UPDATE cpa_profiles SET subscription_status/);
  assert.match(helper, /UPDATE users SET subscription_status/);
});

test('paid tiers are stored without the interval suffix', () => {
  assert.match(SRC, /const baseTier = \(t\) => String\(t \|\| 'professional'\)\.replace\(\/_\(monthly\|yearly\)\$\/, ''\)/);
});
