// modules/referrals/incentives.js
// Non-cash incentives ledger. The credit_type enum is closed and there is no
// cash-out path (compliance 12.1). Phase 1 records the ledger and the
// pending_review gate; the live Stripe coupon application (applyCredit) is a
// Phase 3 step and is NOT invoked before then.
//
// buildIncentives({ config, stripe, service, captureError }) -> { issueOnConversion,
//   reviewSelfReportedCredit, applyCredit }

'use strict';

function buildIncentives({ config, stripe, service, captureError }) {
  // Issue a credit to the referrer on conversion. Self-reported conversions land
  // 'pending_review' with no money movement until an admin approves.
  async function issueOnConversion(pool, cfg, referral, opts) {
    const proId = referral.referrer_pro_id;
    if (proId == null) return { issued: false, reason: 'no referrer pro (platform-originated)' };
    if (!cfg.HAS_SUBSCRIPTIONS) return { issued: false, reason: 'platform has no subscriptions' };

    const pendingReview = opts && opts.pendingReview === true;

    // Annual cap: at most MAX_CREDITS_PER_YEAR applied free months per rolling year.
    const cap = await pool.query(
      `SELECT count(*)::int AS n FROM network_referral_credits
        WHERE pro_id = $1 AND credit_type = 'free_month' AND status = 'applied'
          AND applied_at > now() - interval '12 months'`,
      [proId]
    );
    if (cap.rows[0].n >= cfg.MAX_CREDITS_PER_YEAR) {
      await service.recordEvent(pool, referral.id, 'credit_pending_review', {
        pro_id: proId, capped: true, note: `annual cap (${cfg.MAX_CREDITS_PER_YEAR}) reached`,
      });
      return { issued: false, reason: 'annual cap reached' };
    }

    const status = pendingReview ? 'pending_review' : 'earned';
    const ins = await pool.query(
      `INSERT INTO network_referral_credits (pro_id, referral_id, credit_type, amount, status)
       VALUES ($1, $2, 'free_month', 1, $3) RETURNING id`,
      [proId, referral.id, status]
    );
    await service.recordEvent(pool, referral.id, pendingReview ? 'credit_pending_review' : 'credit_issued', {
      pro_id: proId, credit_id: ins.rows[0].id, status,
    });
    // Also bump the referrer's converted counter (best-effort, non-blocking read path).
    try {
      await pool.query(
        `UPDATE ${cfg.PRO_TABLE} SET referrals_converted_count = referrals_converted_count + 1 WHERE id = $1`,
        [proId]
      );
    } catch (err) {
      console.error('[referrals/incentives] converted_count bump failed:', err.message);
    }
    return { issued: true, creditId: ins.rows[0].id, status };
  }

  // Admin approves/rejects a self-reported credit. Approve -> 'earned' (and apply
  // if a subscription exists, Phase 3). Reject -> 'rejected'.
  async function reviewSelfReportedCredit(pool, cfg, creditId, decision, adminEmail, note) {
    const { rows } = await pool.query(`SELECT * FROM network_referral_credits WHERE id = $1`, [creditId]);
    if (rows.length === 0) return { ok: false, message: 'credit not found' };
    const credit = rows[0];
    if (credit.status !== 'pending_review') return { ok: false, message: `credit is ${credit.status}, not pending_review` };

    if (decision === 'approve') {
      await pool.query(
        `UPDATE network_referral_credits SET status = 'earned', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`,
        [creditId, adminEmail || null, note || null]
      );
      if (credit.referral_id) await service.recordEvent(pool, credit.referral_id, 'credit_issued', { credit_id: creditId, approved_by: adminEmail || null });
      return { ok: true, status: 'earned' };
    }
    // reject
    await pool.query(
      `UPDATE network_referral_credits SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`,
      [creditId, adminEmail || null, note || null]
    );
    return { ok: true, status: 'rejected' };
  }

  // Phase 3 ONLY. Apply an 'earned' credit to a live Stripe subscription as a
  // one-time 100%-off coupon. Not called in Phase 1.
  async function applyCredit(pool, cfg, creditId, subscriptionId) {
    if (!stripe) throw new Error('stripe client not injected');
    const coupon = cfg.STRIPE_REFERRAL_COUPON;
    // Current API: discounts[], not the deprecated top-level coupon param.
    await stripe.subscriptions.update(subscriptionId, { discounts: [{ coupon }] });
    await pool.query(
      `UPDATE network_referral_credits SET status = 'applied', applied_at = now(), stripe_coupon_id = $2 WHERE id = $1`,
      [creditId, coupon]
    );
    return { ok: true };
  }

  return { issueOnConversion, reviewSelfReportedCredit, applyCredit };
}

module.exports = { buildIncentives };
