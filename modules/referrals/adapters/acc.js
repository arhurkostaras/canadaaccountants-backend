// modules/referrals/adapters/acc.js
// ACC-specific matcher integration. The shared service is platform-agnostic and
// calls deps.matchInbound(pool, config, referral); this file provides the ACC
// implementation. The scorer itself (runCPAMatchingAlgorithm) lives un-exported
// in server.js and is injected at wire-up as injected.runMatch.
//
// Named decision (spec 5.2): synthesize a client_profiles-equivalent row from the
// inbound referral and run it through the ONE existing scoring path - do not fork
// the scorer. Referred and organic clients stay on the same tested logic.

'use strict';

// Map an inbound referral to a client_profiles row. Non-derivable fields get
// referral-sourced defaults, flagged so match-quality analytics can segment them.
async function synthesizeClientProfile(pool, config, referral) {
  const ins = await pool.query(
    `INSERT INTO ${config.CLIENT_TABLE}
       (service_type, business_size, fee_preference, province, city,
        meeting_preference, contact_name, contact_email, contact_phone)
     VALUES ($1, NULL, NULL, $2, NULL, 'virtual', $3, $4, $5)
     RETURNING *`,
    [
      referral.need_category,           // service_type
      referral.client_province || null, // province
      referral.client_name || null,     // contact_name
      referral.client_email || null,    // contact_email
      referral.client_phone || null,    // contact_phone
    ]
  );
  return ins.rows[0];
}

// Pros already offered this referral (from prior 'matched' events) are excluded
// so a re-match lands on the NEXT-best pro, not the same one.
async function priorMatchedProIds(pool, referralId) {
  const { rows } = await pool.query(
    `SELECT detail->>'matched_pro_id' AS pid FROM network_referral_events
      WHERE referral_id = $1 AND event_type = 'matched'`,
    [referralId]
  );
  return new Set(rows.map((r) => parseInt(r.pid, 10)).filter((n) => Number.isFinite(n)));
}

function buildAdapter(injected) {
  const runMatch = injected && injected.runMatch;

  async function matchInbound(pool, config, referral) {
    if (typeof runMatch !== 'function') {
      throw new Error('ACC matcher (runCPAMatchingAlgorithm) was not injected');
    }
    const clientProfile = await synthesizeClientProfile(pool, config, referral);
    const excluded = await priorMatchedProIds(pool, referral.id);

    // runCPAMatchingAlgorithm scores + persists matches and returns top candidates.
    const candidates = (await runMatch(clientProfile)) || [];
    const eligible = candidates
      .filter((m) => m && m.cpa && !excluded.has(m.cpa.id))
      .sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));

    if (eligible.length === 0) {
      return { matched: false, matched_client_profile_id: clientProfile.id };
    }
    const top = eligible[0];
    const cpa = top.cpa;
    const name = [cpa.first_name, cpa.last_name].filter(Boolean).join(' ').trim() || cpa.firm_name || 'CPA';
    return {
      matched: true,
      matched_pro_id: cpa.id,
      matched_pro_name: name,
      matched_pro_email: cpa.email || null,
      matched_client_profile_id: clientProfile.id,
      match_reason: `score ${Math.round(top.overall_score || 0)}`,
    };
  }

  return { matchInbound };
}

module.exports = { buildAdapter, synthesizeClientProfile };
