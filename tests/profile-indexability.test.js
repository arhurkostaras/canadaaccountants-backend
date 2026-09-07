// Pins the profile indexability threshold (OPERATIONS.md 2026-09-07, item B) in both its
// forms: the JS classifier and the SQL predicate, plus the server.js wiring that must read
// through the module so no path can carry its own copy of the rule.
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const {
  INDEXABLE_SQL, INDEXABILITY_COLUMNS, classifyProfile, profilePath, profileUrl, withPublicIndexFields,
} = require('../utils/profile-indexability');

const base = () => ({
  id: 123, email: 'a@b.ca', enriched_email: null, status: 'enriched',
  is_misclassified: null, has_enrichment_collision: false, is_generic_inbox: null,
  firm_name: 'Firm LLP', city: 'Toronto', generated_bio: 'A real bio.', designation: 'CPA, CA',
});

test('absent row is a 404', () => {
  assert.deepStrictEqual(classifyProfile(null), { http_status: 404, indexable: false, reason: 'not_found' });
});

test('each gate flag is a 410 with its reason, before any threshold check', () => {
  assert.deepStrictEqual(classifyProfile({ ...base(), is_misclassified: true, misclassified_reason: 'lawyer' }),
    { http_status: 410, indexable: false, reason: 'lawyer' });
  assert.strictEqual(classifyProfile({ ...base(), is_misclassified: true }).reason, 'misclassified');
  assert.strictEqual(classifyProfile({ ...base(), has_enrichment_collision: true }).http_status, 410);
  assert.strictEqual(classifyProfile({ ...base(), is_generic_inbox: true }).reason, 'generic_inbox');
  // gated wins even when the row is otherwise empty
  assert.strictEqual(classifyProfile({ is_generic_inbox: true }).http_status, 410);
});

test('a complete, ungated row is indexable', () => {
  assert.deepStrictEqual(classifyProfile(base()), { http_status: 200, indexable: true, reason: 'ok' });
});

test('threshold: email, valid status, firm, city, and bio-or-designation', () => {
  const noindex = (patch, reason) => {
    const r = classifyProfile({ ...base(), ...patch });
    assert.deepStrictEqual(r, { http_status: 200, indexable: false, reason }, JSON.stringify(patch));
  };
  noindex({ email: null }, 'no_email');
  noindex({ email: '  ' }, 'no_email');
  noindex({ status: 'invalid' }, 'invalid_status');
  noindex({ firm_name: '' }, 'no_firm');
  noindex({ city: null }, 'no_city');
  noindex({ generated_bio: null, designation: ' ' }, 'no_bio_or_designation');
  // enriched_email alone satisfies the email requirement
  assert.strictEqual(classifyProfile({ ...base(), email: null, enriched_email: 'x@y.ca' }).indexable, true);
  // bio alone, or designation alone, satisfies the last clause
  assert.strictEqual(classifyProfile({ ...base(), designation: null }).indexable, true);
  assert.strictEqual(classifyProfile({ ...base(), generated_bio: null }).indexable, true);
  // phone is never required
  assert.strictEqual(classifyProfile({ ...base(), phone: null }).indexable, true);
});

test('SQL predicate carries every clause of the threshold and no phone clause', () => {
  for (const frag of [
    "NULLIF(TRIM(enriched_email), '') IS NOT NULL",
    "NULLIF(TRIM(email), '') IS NOT NULL",
    "status IS DISTINCT FROM 'invalid'",
    'is_misclassified IS TRUE', 'has_enrichment_collision IS TRUE', 'is_generic_inbox IS TRUE',
    "NULLIF(TRIM(firm_name), '') IS NOT NULL",
    "NULLIF(TRIM(city), '') IS NOT NULL",
    "NULLIF(TRIM(generated_bio), '') IS NOT NULL OR NULLIF(TRIM(designation), '') IS NOT NULL",
  ]) assert.ok(INDEXABLE_SQL.includes(frag), `missing clause: ${frag}`);
  assert.ok(!/phone/.test(INDEXABLE_SQL), 'phone must not be part of the threshold');
  for (const col of ['email', 'enriched_email', 'status', 'firm_name', 'city', 'generated_bio', 'designation'])
    assert.ok(INDEXABILITY_COLUMNS.split(', ').includes(col), `INDEXABILITY_COLUMNS lacks ${col}`);
});

test('canonical page location is the static /profile/{id}/ path', () => {
  assert.strictEqual(profilePath(42), '/profile/42/');
  assert.strictEqual(profileUrl(42), 'https://canadaaccountants.app/profile/42/');
});

test('withPublicIndexFields strips private columns and attaches profile_url only when indexable', () => {
  const pub = withPublicIndexFields({ ...base(), full_name: 'A B' });
  assert.strictEqual(pub.email, undefined);
  assert.strictEqual(pub.enriched_email, undefined);
  assert.strictEqual(pub.status, undefined);
  assert.strictEqual(pub.is_misclassified, undefined);
  assert.strictEqual(pub.generated_bio, undefined);
  assert.strictEqual(pub.firm_name, 'Firm LLP');
  assert.strictEqual(pub.indexable, true);
  assert.strictEqual(pub.profile_url, '/profile/123/');
  const held = withPublicIndexFields({ ...base(), city: null });
  assert.strictEqual(held.indexable, false);
  assert.strictEqual(held.profile_url, null);
});

test('server.js reads the rule through the module: sitemap, related, directory, profile API', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("require('./utils/profile-indexability')"), 'server.js must require the module');
  // The retired ad-hoc filter (email-only, ?id= URL form) must not come back in the sitemap route.
  const sitemap = src.slice(src.indexOf("app.get('/api/sitemap-profiles.xml'"), src.indexOf("app.post('/api/admin/cleanup-test-claims'"));
  assert.ok(sitemap.includes('INDEXABLE_SQL'), 'sitemap route must filter with INDEXABLE_SQL');
  assert.ok(!sitemap.includes('profile?id='), 'sitemap must emit the static /profile/{id}/ form');
  const profile = src.slice(src.indexOf("app.get('/api/profiles/:id'"), src.indexOf('// ── Public Directory Endpoints'));
  assert.ok(profile.includes('classifyProfile('), 'profile API must expose the indexable flag');
  assert.ok(profile.includes('INDEXABLE_SQL'), 'related profiles must be filtered to indexable rows');
  const directory = src.slice(src.indexOf("app.get('/api/directory/city/:city'"), src.indexOf('// Founder outreach: weekly digest'));
  assert.strictEqual((directory.match(/GATED_SQL/g) || []).length, 6, 'all 3 directory endpoints filter gated rows in list + count queries');
});
