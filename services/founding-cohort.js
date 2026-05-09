// Founding-cohort merge-tag resolver + subject-line dynamism (Section 4.3 of
// campaign brief v1.7).
//
// Reads founding_cohort_config (Section 4.7) for the current platform's cap +
// current_count, exposes merge-tag substitution and the Subject A/B decision
// per the 40% threshold rule.
//
// Forward-compatible: the sequence runner (Section 4.4, future build) calls
// these helpers when rendering supply_v2 sequence templates. Existing campaigns
// don't use these tags so this module has no effect on current sends.

const PLATFORM = 'acc';

async function getState(pool) {
  const r = await pool.query(
    `SELECT cap, current_count, pricing_lock_months, success_fee_pct
     FROM founding_cohort_config WHERE platform = $1`,
    [PLATFORM]
  );
  if (r.rows.length === 0) {
    // Migration hasn't run yet, or table missing on this backend.
    return { filled: 0, cap: 0, remaining: 0, ratio: 0, suppress_subject_b: true, success_fee_pct: null, lock_months: 24 };
  }
  const row = r.rows[0];
  const filled = row.current_count || 0;
  const cap = row.cap || 0;
  const remaining = Math.max(0, cap - filled);
  const ratio = cap > 0 ? filled / cap : 0;
  return {
    filled,
    cap,
    remaining,
    ratio,
    suppress_subject_b: ratio < 0.40,
    success_fee_pct: row.success_fee_pct == null ? null : Number(row.success_fee_pct),
    lock_months: row.pricing_lock_months || 24
  };
}

// Replace founding-cohort merge tags in a template string. Unknown tags are
// left intact for the caller (other systems may handle them).
function resolveMergeTags(template, state) {
  if (!template) return template;
  return String(template)
    .replace(/\{\{founding_filled\}\}/g, String(state.filled ?? 0))
    .replace(/\{\{founding_cap\}\}/g, String(state.cap ?? 0))
    .replace(/\{\{founding_remaining\}\}/g, String(state.remaining ?? 0))
    .replace(/\{\{pricing_lock_months\}\}/g, String(state.lock_months ?? 24))
    .replace(/\{\{success_fee_pct\}\}/g, state.success_fee_pct == null ? '' : String(state.success_fee_pct));
}

// Choose Subject A or Subject B per the 40% threshold rule (Section 4.3).
// If subject_b is missing or threshold not met, returns subject_a.
function chooseSubject({ subject_a, subject_b, state }) {
  if (!subject_b) return { subject: subject_a, variant: 'a', reason: 'no subject_b configured' };
  if (state.suppress_subject_b) {
    return { subject: subject_a, variant: 'a', reason: `founding ratio ${(state.ratio * 100).toFixed(1)}% below 40% threshold` };
  }
  return { subject: subject_b, variant: 'b', reason: `founding ratio ${(state.ratio * 100).toFixed(1)}% meets 40% threshold` };
}

module.exports = { PLATFORM, getState, resolveMergeTags, chooseSubject };
