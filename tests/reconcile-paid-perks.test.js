// Pure-function tests for scripts/reconcile-paid-perks.js (read-only Stripe vs
// database reconciliation written for the 2026-10-05 payment hotfix).
const { test } = require('node:test');
const assert = require('node:assert');
const { classify, draftNote, grantSql, PLATFORMS } = require('../scripts/reconcile-paid-perks');

const paid = { id: 'sub_1', status: 'active', email: 'a@b.ca' };
const user = { id: 7, subscription_status: 'none' };
const profile = { id: 12, subscription_status: 'unclaimed' };

test('a payer with no subscription row is flagged', () => {
  assert.strictEqual(classify(paid, { row: null, user, profile }), 'MISSING_SUB_ROW');
});

test('a payer whose row is not active is flagged', () => {
  assert.strictEqual(classify(paid, { row: { status: 'canceled' }, user, profile }), 'STALE_STATUS');
});

test('a payer we cannot match to any account is flagged', () => {
  assert.strictEqual(classify(paid, { row: null, user: null, profile: null }), 'NO_ACCOUNT');
});

test('past_due is still entitled (Stripe retry window)', () => {
  assert.strictEqual(classify({ ...paid, status: 'past_due' }, { row: { status: 'past_due' }, user, profile }), 'OK');
});

test('a canceled member who kept any paid flag is flagged', () => {
  const canceled = { ...paid, status: 'canceled' };
  assert.strictEqual(classify(canceled, { row: { status: 'canceled' }, user: { subscription_status: 'active' }, profile }), 'PERKS_LEAKED');
  assert.strictEqual(classify(canceled, { row: { status: 'canceled' }, user, profile: { subscription_status: 'active' } }), 'PERKS_LEAKED');
  assert.strictEqual(classify(canceled, { row: { status: 'canceled' }, user, profile }), 'OK');
});

test('draft note names the tier and the credit, and promises nothing else', () => {
  const note = draftNote({ brand: 'CanadaAccountants', firstName: 'Dana', tier: 'professional_yearly', since: '2026-09-01', credit: 299 });
  assert.match(note, /Hi Dana,/);
  assert.match(note, /Professional features you paid for/);
  assert.match(note, /credit of \$299/);
  assert.doesNotMatch(note, /\n\n\n/);
  assert.doesNotMatch(draftNote({ brand: 'X', tier: 'associate' }), /credit/);
});

test('grant SQL is idempotent and targets the platform tables', () => {
  const sql = grantSql(PLATFORMS.inv, { profileId: 3, userId: 9, sub: { id: 'sub_9', customer: 'cus_1' }, tier: 'enterprise_monthly', email: "o'neil@x.ca" });
  assert.match(sql, /INSERT INTO advisor_subscriptions \(advisor_profile_id, plan_type/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.doesNotMatch(sql, /advisor_profiles SET subscription_status/, 'advisor_profiles has no subscription_status');
  assert.match(sql, /'enterprise'/);
  const acc = grantSql(PLATFORMS.acc, { profileId: 3, userId: null, sub: { id: 's', customer: 'c' }, tier: 'associate', email: "o'neil@x.ca" });
  assert.match(acc, /'o''neil@x\.ca'/, 'quotes are escaped');
});
