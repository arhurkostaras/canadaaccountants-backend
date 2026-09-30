// Stripe revenue proof: which subscription states count as paid, how yearly and
// multi-month prices normalise to a month, and the marked fallback to the local
// table when Stripe cannot be read. No network, no database: the Stripe client
// and the pool are fakes shaped like the live objects (30 Sep 2026 states).
const test = require('node:test');
const assert = require('node:assert');
const revenue = require('../services/stripe-revenue');

function sub(overrides, price) {
  const p = Object.assign({ unit_amount: 29900, recurring: { interval: 'month', interval_count: 1 } }, price || {});
  return Object.assign({ status: 'active', pause_collection: null, cancel_at_period_end: false, cancel_at: null,
    items: { data: [{ quantity: 1, price: p }] } }, overrides);
}

// Mirrors the three live accounts on 30 Sep 2026 plus the shapes the digest must tell apart.
const FIXTURES = [
  sub({ id: 'paid_monthly' }),
  sub({ id: 'law_like_paused', pause_collection: { behavior: 'keep_as_draft', resumes_at: null } }),
  sub({ id: 'inv_like_ended', status: 'canceled', cancel_at_period_end: true, ended_at: 1787838783 }),
  sub({ id: 'cancelling_yearly', cancel_at_period_end: true }, { unit_amount: 238800, recurring: { interval: 'year', interval_count: 1 } }),
  sub({ id: 'past_due' , status: 'past_due' }, { unit_amount: 19900 }),
  sub({ id: 'trial', status: 'trialing' }),
  sub({ id: 'paid_yearly' }, { unit_amount: 238800, recurring: { interval: 'year', interval_count: 1 } }),
  sub({ id: 'paid_quarterly' }, { unit_amount: 89700, recurring: { interval: 'month', interval_count: 3 } }),
  sub({ id: 'incomplete', status: 'incomplete' })
];

function fakeStripe(list) {
  const calls = [];
  return { calls, subscriptions: { list(params) { calls.push(params); if (list instanceof Error) throw list; return list; } } };
}
function fakePool(rows) {
  const calls = [];
  return { calls, query(sql, params) { calls.push({ sql, params }); if (rows instanceof Error) return Promise.reject(rows); return Promise.resolve({ rows, rowCount: rows.length }); } };
}

test('classify: only active, unpaused, non-cancelling subscriptions are paid', () => {
  assert.strictEqual(revenue.classify(FIXTURES[0]), 'paid');
  assert.strictEqual(revenue.classify(FIXTURES[1]), 'paused');
  assert.strictEqual(revenue.classify(FIXTURES[2]), null);
  assert.strictEqual(revenue.classify(FIXTURES[3]), 'cancelling');
  assert.strictEqual(revenue.classify(FIXTURES[4]), 'past_due');
  assert.strictEqual(revenue.classify({ status: 'unpaid' }), 'past_due');
  assert.strictEqual(revenue.classify(FIXTURES[5]), 'trialing');
  assert.strictEqual(revenue.classify(FIXTURES[8]), null);
  assert.strictEqual(revenue.classify(null), null);
});

test('monthlyCents normalises yearly, multi-month, weekly and quantity; plan-shaped items work too', () => {
  assert.strictEqual(revenue.monthlyCents({ quantity: 1, price: { unit_amount: 238800, recurring: { interval: 'year', interval_count: 1 } } }), 19900);
  assert.strictEqual(revenue.monthlyCents({ quantity: 1, price: { unit_amount: 89700, recurring: { interval: 'month', interval_count: 3 } } }), 29900);
  assert.strictEqual(revenue.monthlyCents({ quantity: 2, price: { unit_amount: 29900, recurring: { interval: 'month', interval_count: 1 } } }), 59800);
  assert.strictEqual(Math.round(revenue.monthlyCents({ quantity: 1, price: { unit_amount: 1000, recurring: { interval: 'week', interval_count: 1 } } })), 4348);
  assert.strictEqual(revenue.monthlyCents({ quantity: 1, plan: { amount: 29900, interval: 'month', interval_count: 1 } }), 29900);
  assert.strictEqual(revenue.monthlyCents({ quantity: 1, price: { unit_amount: 29900, recurring: { interval: 'fortnight' } } }), 0);
});

test('collectRevenue from Stripe: counts every state, sums MRR from paid only, asks for all statuses', async () => {
  const stripe = fakeStripe(FIXTURES);
  const pool = fakePool([{ paid: 2, mrr: 598 }]);
  const out = await revenue.collectRevenue({ pool, stripe });
  assert.strictEqual(out.platform, revenue.PLATFORM);
  assert.strictEqual(out.revenue_source, 'stripe');
  assert.strictEqual(out.detail, null);
  assert.strictEqual(out.paid, 3);
  assert.strictEqual(out.mrr, 299 + 199 + 299);
  assert.strictEqual(out.paused, 1);
  assert.strictEqual(out.cancelling, 1);
  assert.strictEqual(out.past_due, 1);
  assert.strictEqual(out.trialing, 1);
  assert.deepStrictEqual(stripe.calls[0], { status: 'all', limit: 100 });
  assert.strictEqual(pool.calls.length, 0, 'the local table is not read when Stripe answers');
});

test('collectRevenue: the live 30 Sep 2026 picture is $0 collectible although the local tables say $598', async () => {
  const stripe = fakeStripe([FIXTURES[1], FIXTURES[2]]);
  const out = await revenue.collectRevenue({ pool: fakePool([{ paid: 2, mrr: 598 }]), stripe });
  assert.strictEqual(out.paid, 0);
  assert.strictEqual(out.mrr, 0);
  assert.strictEqual(out.paused, 1);
  assert.strictEqual(out.revenue_source, 'stripe');
});

test('collectRevenue falls back to the local table with a visible marker when Stripe fails, and says when both fail', async () => {
  const pool = fakePool([{ paid: 2, mrr: 598 }]);
  const out = await revenue.collectRevenue({ pool, stripe: fakeStripe(new Error('boom')) });
  assert.strictEqual(out.revenue_source, 'local_table');
  assert.match(out.detail, /Stripe unavailable: boom/);
  assert.strictEqual(out.paid, 2);
  assert.strictEqual(out.mrr, 598);
  assert.strictEqual(out.paused, 0);
  assert.match(pool.calls[0].sql, /_subscriptions WHERE status = 'active'/);

  const failures = [];
  const both = await revenue.collectRevenue({ pool: fakePool(new Error('relation missing')), stripe: fakeStripe(new Error('boom')), failures });
  assert.strictEqual(both.revenue_source, 'unavailable');
  assert.match(both.detail, /relation missing/);
  assert.strictEqual(failures.length, 1);
  assert.match(failures[0].message, /revenue unavailable/);
});

test('collectRevenue without a Stripe key falls back rather than throwing', async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const out = await revenue.collectRevenue({ pool: fakePool([{ paid: 1, mrr: 299 }]) });
    assert.strictEqual(out.revenue_source, 'local_table');
    assert.match(out.detail, /STRIPE_SECRET_KEY unset/);
    assert.strictEqual(out.mrr, 299);
  } finally {
    if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved;
  }
});
