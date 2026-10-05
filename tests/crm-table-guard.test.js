// Pins the NODE-H fix: outreach_recipients exists only on INV, so on ACC/LAW the CRM must
// check for it instead of letting the query fail. Every rejected pool.query reports to
// Sentry (utils/db-error-reporter.js), so a query against the missing table is noise.
const { test } = require('node:test');
const assert = require('node:assert');
const { CRMService, tableExists } = require('../services/crm');

function fakePool(existingTables) {
  const sent = [];
  return {
    sent,
    query: async (text, params = []) => {
      sent.push(String(text));
      if (/to_regclass/.test(text)) return { rows: [{ exists: existingTables.includes(params[0]) }] };
      if (/information_schema\.tables/.test(text)) return { rows: [{ exists: existingTables.includes(params[0]) }] };
      const missing = ['outreach_recipients', 'outreach_emails', 'cpa_subscriptions']
        .find(t => !existingTables.includes(t) && new RegExp(`\\b${t}\\b`).test(text));
      if (missing) throw Object.assign(new Error(`relation "${missing}" does not exist`), { code: '42P01' });
      return { rows: [], rowCount: 0 };
    },
  };
}

test('backfill on ACC never queries outreach_recipients', async () => {
  const db = fakePool(['outreach_emails', 'cpa_subscriptions', 'scraped_cpas']);
  const crm = new CRMService({ db, professionalsTable: 'scraped_cpas', platform: 'accountants' });
  await crm.backfill().catch(() => {});
  const hits = db.sent.filter(t => /FROM outreach_recipients/.test(t));
  assert.strictEqual(hits.length, 0, 'no query may touch outreach_recipients when it is absent');
});

test('backfill on INV still uses outreach_recipients', async () => {
  const db = fakePool(['outreach_recipients', 'advisor_subscriptions', 'scraped_advisors']);
  const crm = new CRMService({ db, professionalsTable: 'scraped_advisors', platform: 'investing' });
  await crm.backfill().catch(() => {});
  assert.strictEqual(db.sent.filter(t => /FROM outreach_recipients/.test(t)).length, 2);
});

test('tableExists caches per pool and treats a failed check as absent without caching it', async () => {
  let calls = 0;
  const db = { query: async () => { calls++; return { rows: [{ exists: true }] }; } };
  assert.strictEqual(await tableExists(db, 'x'), true);
  assert.strictEqual(await tableExists(db, 'x'), true);
  assert.strictEqual(calls, 1);
  let fail = true;
  const flaky = { query: async () => { if (fail) throw new Error('down'); return { rows: [{ exists: true }] }; } };
  assert.strictEqual(await tableExists(flaky, 'y'), false);
  fail = false;
  assert.strictEqual(await tableExists(flaky, 'y'), true);
});
