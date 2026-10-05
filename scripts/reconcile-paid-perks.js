#!/usr/bin/env node
// Read-only reconciliation: who paid in Stripe vs who has paid perks in the
// database, for ACC, LAW or INV. Run it before and after the 2026-10-05 payment
// hotfix to find members who paid and never got their perks (the emailed
// checkout button carried no ids) and members who canceled and kept them.
//
//   PLATFORM=acc DATABASE_URL=... STRIPE_SECRET_KEY=... \
//     node scripts/reconcile-paid-perks.js > reconcile-acc.md
//
// It only runs SELECTs and Stripe list calls. It prints, per affected payer,
// the SQL that would grant their perks and a draft apology note, for Arthur to
// review. It changes nothing, sends nothing, and issues no credit.

'use strict';

const PLATFORMS = {
  acc: { brand: 'CanadaAccountants', subs: 'cpa_subscriptions', subProfileCol: 'cpa_profile_id', tierCol: 'tier',
         profiles: 'cpa_profiles', profileHasStatus: true },
  law: { brand: 'CanadaLawyers', subs: 'lawyer_subscriptions', subProfileCol: 'cpa_profile_id', tierCol: 'tier',
         profiles: 'lawyer_profiles', profileHasStatus: true },
  inv: { brand: 'CanadaInvesting', subs: 'advisor_subscriptions', subProfileCol: 'advisor_profile_id', tierCol: 'plan_type',
         profiles: 'advisor_profiles', profileHasStatus: false },
};
const MONTHLY_PRICE = { associate: 199, professional: 299, enterprise: 599 };
const ENTITLED = ['active', 'trialing', 'past_due'];
const ACTIVE_ROW = ['active', 'trialing', 'past_due'];

// Pure: classify one Stripe subscription against what the database holds.
//   stripeSub: { id, status, email }
//   db: { row (subscription row or null), user (or null), profile (or null) }
function classify(stripeSub, db) {
  const entitled = ENTITLED.includes(stripeSub.status);
  const rowActive = !!(db.row && ACTIVE_ROW.includes(db.row.status));
  const userActive = !!(db.user && db.user.subscription_status === 'active');
  const profileActive = !!(db.profile && db.profile.subscription_status === 'active');
  if (entitled) {
    if (!db.user && !db.profile) return 'NO_ACCOUNT';
    if (!db.row) return 'MISSING_SUB_ROW';
    if (!rowActive) return 'STALE_STATUS';
    return 'OK';
  }
  if (rowActive || userActive || profileActive) return 'PERKS_LEAKED';
  return 'OK';
}

const baseTier = (t) => String(t || 'professional').replace(/_(monthly|yearly)$/, '');

function draftNote({ brand, firstName, tier, since, credit }) {
  const tierName = baseTier(tier).charAt(0).toUpperCase() + baseTier(tier).slice(1);
  return [
    `Subject: Your ${brand} membership is now fully active`,
    '',
    `Hi ${firstName || 'there'},`,
    '',
    `When you subscribed${since ? ` on ${since}` : ''}, a fault on our side meant your account did not show the ${tierName} features you paid for. I have fixed it, and your membership is now fully active.`,
    credit ? `As an apology, I have added a credit of $${credit} to your account. It comes off your next invoice automatically.` : '',
    'If anything still looks wrong, reply to this email and I will sort it out personally.',
    '',
    'Sorry for the trouble,',
    'Arthur Kostaras',
    `Founder, ${brand}`,
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

function grantSql(cfg, { profileId, userId, sub, tier, email }) {
  const t = baseTier(tier);
  const lines = [];
  if (profileId) {
    lines.push(`-- subscription row for profile ${profileId}`);
    lines.push(`UPDATE ${cfg.subs} SET status = 'active', ${cfg.tierCol} = '${t}', stripe_customer_id = '${sub.customer}', updated_at = NOW() WHERE stripe_subscription_id = '${sub.id}';`);
    lines.push(`INSERT INTO ${cfg.subs} (${cfg.subProfileCol}, ${cfg.tierCol}, status, stripe_subscription_id, stripe_customer_id${cfg.subs === 'advisor_subscriptions' ? '' : ', email'}, current_period_start)`);
    lines.push(`  SELECT ${profileId}, '${t}', 'active', '${sub.id}', '${sub.customer}'${cfg.subs === 'advisor_subscriptions' ? '' : `, '${email.replace(/'/g, "''")}'`}, NOW()`);
    lines.push(`  WHERE NOT EXISTS (SELECT 1 FROM ${cfg.subs} WHERE stripe_subscription_id = '${sub.id}');`);
    if (cfg.profileHasStatus) lines.push(`UPDATE ${cfg.profiles} SET subscription_tier = '${t}', subscription_status = 'active' WHERE id = ${profileId};`);
  }
  if (userId) lines.push(`UPDATE users SET subscription_tier = '${t}', subscription_status = 'active', stripe_customer_id = '${sub.customer}' WHERE id = ${userId};`);
  return lines.join('\n');
}

async function main() {
  const key = (process.env.PLATFORM || '').toLowerCase();
  const cfg = PLATFORMS[key];
  if (!cfg) { console.error('PLATFORM must be acc, law or inv'); process.exit(2); }
  if (!process.env.DATABASE_URL || !process.env.STRIPE_SECRET_KEY) {
    console.error('DATABASE_URL and STRIPE_SECRET_KEY are required'); process.exit(2);
  }
  const { Pool } = require('pg');
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // Belt and braces: every statement in this session is read-only.
  pool.on('connect', (c) => c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'));

  const priceIds = Object.entries(process.env)
    .filter(([k, v]) => /^STRIPE_PRICE_/.test(k) && v)
    .map(([, v]) => v);
  const results = [];
  const seenSubIds = new Set();
  try {
    for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.customer'] })) {
      const item = sub.items && sub.items.data && sub.items.data[0];
      const priceId = item && item.price && item.price.id;
      if (priceIds.length && !priceIds.includes(priceId)) continue; // another platform's price
      seenSubIds.add(sub.id);
      const email = (sub.customer && sub.customer.email) || '';
      const interval = item && item.price && item.price.recurring ? item.price.recurring.interval : 'unknown';
      const row = (await pool.query(`SELECT * FROM ${cfg.subs} WHERE stripe_subscription_id = $1 LIMIT 1`, [sub.id])).rows[0] || null;
      const user = email ? (await pool.query('SELECT id, email, subscription_status, subscription_tier FROM users WHERE LOWER(email) = LOWER($1) ORDER BY id DESC LIMIT 1', [email])).rows[0] || null : null;
      const profile = (await pool.query(
        `SELECT * FROM ${cfg.profiles} WHERE LOWER(email) = LOWER($1) OR ($2::int IS NOT NULL AND user_id = $2::int) ORDER BY id DESC LIMIT 1`,
        [email, user ? user.id : null]
      )).rows[0] || null;
      const verdict = classify({ id: sub.id, status: sub.status, email }, { row, user, profile });
      results.push({ sub, email, interval, priceId, row, user, profile, verdict,
        tier: (sub.metadata && sub.metadata.tier) || (row && row[cfg.tierCol]) || 'professional' });
    }
    const orphans = (await pool.query(
      `SELECT id, ${cfg.subProfileCol} AS profile_id, ${cfg.tierCol} AS tier, status, stripe_subscription_id FROM ${cfg.subs}
       WHERE status IN ('active','trialing') AND stripe_subscription_id IS NOT NULL`
    )).rows.filter(r => !seenSubIds.has(r.stripe_subscription_id));

    const count = (v) => results.filter(r => r.verdict === v).length;
    const out = [];
    out.push(`# ${cfg.brand}: Stripe vs database perks (${new Date().toISOString()})`, '');
    out.push(`Stripe subscriptions checked: ${results.length}${priceIds.length ? '' : ' (no STRIPE_PRICE_* set: every subscription in the account was checked)'}`);
    out.push(`OK: ${count('OK')} · paid but no subscription row: ${count('MISSING_SUB_ROW')} · paid, row not active: ${count('STALE_STATUS')} · paid, no account: ${count('NO_ACCOUNT')} · canceled but perks kept: ${count('PERKS_LEAKED')} · active rows unknown to Stripe: ${orphans.length}`, '');
    out.push('| Verdict | Email | Stripe status | Interval | Tier | Since | Subscription |', '|---|---|---|---|---|---|---|');
    for (const r of results.filter(x => x.verdict !== 'OK')) {
      out.push(`| ${r.verdict} | ${r.email || '(none)'} | ${r.sub.status} | ${r.interval} | ${baseTier(r.tier)} | ${new Date(r.sub.created * 1000).toISOString().slice(0, 10)} | ${r.sub.id} |`);
    }
    for (const o of orphans) out.push(`| ACTIVE_ROW_NOT_IN_STRIPE | profile ${o.profile_id} | — | — | ${o.tier} | — | ${o.stripe_subscription_id} |`);

    const toFix = results.filter(r => ['MISSING_SUB_ROW', 'STALE_STATUS'].includes(r.verdict));
    if (toFix.length) out.push('', '## Members to make whole', '', 'Review each block, then run the SQL yourself. The credit is a suggestion: one month at their tier, applied as a Stripe customer balance credit.');
    for (const r of toFix) {
      const credit = MONTHLY_PRICE[baseTier(r.tier)] || null;
      out.push('', `### ${r.email}`, '', '```sql', grantSql(cfg, { profileId: r.profile && r.profile.id, userId: r.user && r.user.id, sub: r.sub, tier: r.tier, email: r.email }), '```', '',
        `Suggested credit: $${credit} (Stripe → Customers → ${r.sub.customer} → Balance → Adjust).`, '', '```',
        draftNote({ brand: cfg.brand, firstName: (r.profile && r.profile.first_name) || '', tier: r.tier, since: new Date(r.sub.created * 1000).toISOString().slice(0, 10), credit }), '```');
    }
    const noAcct = results.filter(r => r.verdict === 'NO_ACCOUNT');
    if (noAcct.length) out.push('', '## Paid with no account', '', 'No user or profile matches these emails. Contact them to set up access by hand.', ...noAcct.map(r => `- ${r.email || '(no email)'}: ${r.sub.id}, customer ${r.sub.customer}`));
    console.log(out.join('\n'));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { classify, draftNote, grantSql, baseTier, PLATFORMS };
