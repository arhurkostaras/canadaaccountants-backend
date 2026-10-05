// Fit gate for CPA matching (services/cpa-match-eligibility.js). Before it,
// every September 2026 ACC request went to one claimed, unverified, in-house
// CPA whose score the "regulatory gate" capped at 40 but still returned.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { cpaEligibility, provinceFromText } = require('../services/cpa-match-eligibility');

const verifiedON = { verification_status: 'verified', province: 'ON' };
const designatedAB = { verification_status: 'pending', designation: 'CPA', province: 'Alberta' };
const unverified = { verification_status: 'pending', designation: null, province: 'ON' };

test('an unverified CPA without a designation is never a match', () => {
  assert.deepStrictEqual(cpaEligibility({ province: 'ON' }, unverified), { ok: false, reason: 'unverified' });
  assert.deepStrictEqual(cpaEligibility({}, unverified), { ok: false, reason: 'unverified' });
});

test('client province must match unless the client asked for virtual meetings', () => {
  assert.deepStrictEqual(cpaEligibility({ province: 'Ontario' }, verifiedON), { ok: true, reason: null });
  assert.deepStrictEqual(cpaEligibility({ province: 'AB' }, verifiedON), { ok: false, reason: 'province' });
  assert.deepStrictEqual(cpaEligibility({ province: 'AB', meetingPreference: 'Virtual' }, verifiedON), { ok: true, reason: null });
  assert.deepStrictEqual(cpaEligibility({ province: 'AB' }, designatedAB), { ok: true, reason: null });
});

test('location text resolves; unknown province does not exclude', () => {
  assert.strictEqual(provinceFromText('Calgary, AB'), 'AB');
  assert.strictEqual(provinceFromText('Toronto ON'), 'ON');
  assert.strictEqual(provinceFromText('Belfast'), null);
  assert.deepStrictEqual(cpaEligibility({ location: 'Calgary, AB' }, verifiedON), { ok: false, reason: 'province' });
  assert.deepStrictEqual(cpaEligibility({ location: 'Belfast' }, verifiedON), { ok: true, reason: null });
});

test('both ACC matchers filter through the gate before scoring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /cpas\.rows\.filter\(cpa => cpaEligibility\(client, cpa\)\.ok\)\.map\(scoreCpaRow\)/);
  assert.match(src, /result\.rows\.filter\(cpa => cpaEligibility\(client, cpa\)\.ok\)\.map\(scoreCPA\)/);
});
