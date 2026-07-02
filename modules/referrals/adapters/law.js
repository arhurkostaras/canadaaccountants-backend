// modules/referrals/adapters/law.js
// LAW-specific matcher integration. Mirror of adapters/acc.js for the LAW
// monolith: the scorer (runLawyerMatchingAlgorithm) lives un-exported in LAW's
// server.js and is injected at wire-up as injected.runMatch. It takes a
// client_profiles row and returns candidates keyed .lawyer (ACC's are .cpa),
// persisting matches itself - same one-scoring-path rule as ACC (spec 5.2).
//
// LAW's client_profiles is case-shaped (case_type / case_complexity /
// fee_preference), not service-shaped like ACC's. need_category maps to
// case_type; non-derivable fields stay NULL, which the scorer already treats
// as "no preference" (complexity -> 70, fee -> 80).

'use strict';

async function synthesizeClientProfile(pool, config, referral) {
  const ins = await pool.query(
    `INSERT INTO ${config.CLIENT_TABLE}
       (case_type, case_complexity, budget_range, fee_preference, province, city,
        meeting_preference, contact_name, contact_email, contact_phone)
     VALUES ($1, NULL, NULL, NULL, $2, NULL, 'virtual', $3, $4, $5)
     RETURNING *`,
    [
      referral.need_category,           // case_type
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
      throw new Error('LAW matcher (runLawyerMatchingAlgorithm) was not injected');
    }
    const clientProfile = await synthesizeClientProfile(pool, config, referral);
    const excluded = await priorMatchedProIds(pool, referral.id);

    // runLawyerMatchingAlgorithm scores + persists matches and returns top candidates.
    const candidates = (await runMatch(clientProfile)) || [];
    const eligible = candidates
      .filter((m) => m && m.lawyer && !excluded.has(m.lawyer.id))
      .sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));

    if (eligible.length === 0) {
      return { matched: false, matched_client_profile_id: clientProfile.id };
    }
    const top = eligible[0];
    const lawyer = top.lawyer;
    const name = [lawyer.first_name, lawyer.last_name].filter(Boolean).join(' ').trim() || lawyer.firm_name || 'Lawyer';
    return {
      matched: true,
      matched_pro_id: lawyer.id,
      matched_pro_name: name,
      matched_pro_email: lawyer.email || null,
      matched_client_profile_id: clientProfile.id,
      match_reason: `score ${Math.round(top.overall_score || 0)}`,
    };
  }

  return { matchInbound };
}

module.exports = { buildAdapter, synthesizeClientProfile };
