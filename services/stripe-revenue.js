// Revenue for the daily digest, read from Stripe instead of the local
// subscriptions table. The local table only changes when a webhook lands, and
// it says nothing about a subscription whose collection is paused or that is
// set to cancel at period end, so it kept reporting $299 MRR on ACC
// after the money had stopped (30 Sep 2026 triage, action A5).
//
// Rules: a subscription counts as paid only when it is active, not paused and
// not cancelling. Yearly (and weekly, daily, multi-month) prices are
// normalised to a monthly amount. If Stripe cannot be read (no key, network,
// API error) the local table is used and revenue_source says so, so the digest
// never shows a number without saying where it came from.
//
// Three copies, not a shared module (see BACKPRESSURE_LEDGER.md): this file is
// duplicated across ACC / LAW / INV and differs only in the block below.

const PLATFORM = 'ACC';
const LOCAL_TABLE = 'cpa_subscriptions';
const LOCAL_TIER_COLUMN = 'tier';
const TIER_PRICES = { enterprise: 599, professional: 299, associate: 199 };

// Months covered by one billing interval of the given unit.
const MONTHS_PER = { month: 1, year: 12, week: 7 / 30.4375, day: 1 / 30.4375 };

// Monthly cents for one subscription item (price × quantity, normalised).
function monthlyCents(item) {
  const price = item.price || item.plan || {};
  const recurring = price.recurring || { interval: price.interval, interval_count: price.interval_count };
  const unit = Number(price.unit_amount != null ? price.unit_amount : price.amount) || 0;
  const quantity = Number(item.quantity) || 1;
  const months = (MONTHS_PER[recurring.interval] || 0) * (Number(recurring.interval_count) || 1);
  if (!months) return 0;
  return (unit * quantity) / months;
}

// One of paid | paused | cancelling | past_due | trialing, or null for a
// subscription that has ended or never started (canceled, incomplete, expired).
function classify(sub) {
  if (!sub) return null;
  if (sub.status === 'past_due' || sub.status === 'unpaid') return 'past_due';
  if (sub.status === 'trialing') return 'trialing';
  if (sub.status !== 'active') return null;
  if (sub.pause_collection) return 'paused';
  if (sub.cancel_at_period_end || sub.cancel_at) return 'cancelling';
  return 'paid';
}

function emptyRevenue() {
  return { platform: PLATFORM, paid: 0, mrr: 0, paused: 0, cancelling: 0, past_due: 0, trialing: 0, revenue_source: 'stripe', detail: null };
}

async function fromStripe(client) {
  const out = emptyRevenue();
  let cents = 0;
  for await (const sub of client.subscriptions.list({ status: 'all', limit: 100 })) {
    const state = classify(sub);
    if (!state) continue;
    out[state] += 1;
    if (state === 'paid') cents += ((sub.items && sub.items.data) || []).reduce((sum, item) => sum + monthlyCents(item), 0);
  }
  out.mrr = Math.round(cents / 100);
  return out;
}

async function fromLocalTable(pool) {
  const cases = Object.entries(TIER_PRICES).map(([tier, price]) => `WHEN ${LOCAL_TIER_COLUMN} = '${tier}' THEN ${price}`).join(' ');
  const r = await pool.query(
    `SELECT COUNT(*)::int AS paid, COALESCE(SUM(CASE ${cases} ELSE 0 END), 0)::int AS mrr
       FROM ${LOCAL_TABLE} WHERE status = 'active' AND ${LOCAL_TIER_COLUMN} <> 'free'`);
  const row = (r && r.rows && r.rows[0]) || {};
  return { paid: Number(row.paid) || 0, mrr: Number(row.mrr) || 0 };
}

// deps: { pool, stripe?, failures? }. stripe is injectable for tests; by default
// a client is built from STRIPE_SECRET_KEY. failures, when given, receives an
// entry only when neither Stripe nor the local table could be read.
async function collectRevenue({ pool, stripe, failures } = {}) {
  let stripeError = null;
  try {
    const client = stripe || (process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null);
    if (!client) throw new Error('STRIPE_SECRET_KEY unset');
    return await fromStripe(client);
  } catch (err) {
    stripeError = err;
    console.error('[StripeRevenue] Stripe read failed, falling back to the local table:', err.message);
  }
  const out = emptyRevenue();
  out.revenue_source = 'local_table';
  out.detail = `Stripe unavailable: ${stripeError.message}`;
  try {
    const local = await fromLocalTable(pool);
    out.paid = local.paid;
    out.mrr = local.mrr;
  } catch (err) {
    console.error('[StripeRevenue] local table read failed too:', err.message);
    out.revenue_source = 'unavailable';
    out.detail = `Stripe unavailable: ${stripeError.message}; local table unavailable: ${err.message}`;
    if (failures) failures.push({ platform: PLATFORM, message: `revenue unavailable from Stripe (${stripeError.message}) and from ${LOCAL_TABLE} (${err.message})` });
  }
  return out;
}

module.exports = { PLATFORM, TIER_PRICES, monthlyCents, classify, collectRevenue, _fromLocalTable: fromLocalTable };
