// Hard eligibility for CPA matching, applied before any scoring in both the
// find-a-CPA matcher (runCPAMatchingAlgorithm) and the friction matcher
// (generateFrictionBasedMatches). Scores rank the CPAs who can take the work;
// they never turn an ineligible CPA into a match.
//
// Before this gate, every ACC client request in September 2026 went to one
// claimed, unverified, in-house CPA: the "regulatory gate" only capped an
// unverified CPA's score at 40 and still returned them as a match.
//
//   - Verification: the CPA must be verified, registry-checked, or hold a
//     recorded designation (the same three states the regulatory score treats
//     as passing). Anyone else is not presented to clients.
//   - Province: when the client's province is known and they have not asked to
//     meet virtually, the CPA must practise in it. With no known province, or a
//     virtual preference, province does not exclude.
//
// The house fallback (findHouseFallbackCpa) is outside this gate by design.

'use strict';

const PROVINCES = {
  on: 'ON', ont: 'ON', ontario: 'ON',
  qc: 'QC', pq: 'QC', quebec: 'QC', qubec: 'QC',
  bc: 'BC', britishcolumbia: 'BC',
  ab: 'AB', alberta: 'AB',
  sk: 'SK', sask: 'SK', saskatchewan: 'SK',
  mb: 'MB', man: 'MB', manitoba: 'MB',
  ns: 'NS', novascotia: 'NS',
  nb: 'NB', newbrunswick: 'NB',
  pe: 'PE', pei: 'PE', princeedwardisland: 'PE',
  nl: 'NL', nf: 'NL', newfoundland: 'NL', newfoundlandandlabrador: 'NL',
  yt: 'YT', yukon: 'YT',
  nt: 'NT', nwt: 'NT', northwestterritories: 'NT',
  nu: 'NU', nunavut: 'NU',
};

function provinceCode(value) {
  const key = String(value == null ? '' : value).toLowerCase().replace(/[^a-z]/g, '');
  return PROVINCES[key] || null;
}

// "Toronto, ON" / "Calgary AB" / "ON" / "Ontario" -> two-letter code or null.
function provinceFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const direct = provinceCode(raw);
  if (direct) return direct;
  const parts = raw.split(/[,/\s]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const code = provinceCode(parts[i]);
    if (code) return code;
  }
  return null;
}

const PASSING_VERIFICATION = ['verified', 'registry_checked'];

// client: { province, location, meetingPreference }
// Returns { ok: boolean, reason: null | 'unverified' | 'province' }.
function cpaEligibility(client, cpa) {
  const verified = PASSING_VERIFICATION.includes(cpa.verification_status) || !!(cpa.designation && String(cpa.designation).trim());
  if (!verified) return { ok: false, reason: 'unverified' };

  const virtual = String(client.meetingPreference || '').toLowerCase() === 'virtual';
  const clientProvince = provinceFromText(client.province) || provinceFromText(client.location);
  if (clientProvince && !virtual && provinceCode(cpa.province) !== clientProvince) {
    return { ok: false, reason: 'province' };
  }
  return { ok: true, reason: null };
}

module.exports = { cpaEligibility, provinceCode, provinceFromText };
