// Pins the profile indexability threshold (OPERATIONS.md 2026-10-05 two-tier admission,
// superseding the 2026-09-07 item B) in both its forms: the JS classifier and the SQL
// predicate, the two delivery tiers (static file vs SPA), plus the server.js wiring that
// must read through the module so no path can carry its own copy of the rule.
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const {
  INDEXABLE_SQL, STATIC_TIER_SQL, SPA_TIER_SQL, INDEXABILITY_COLUMNS, classifyProfile, tierOf,
  profilePath, profileUrl, staticPath, spaPath, withPublicIndexFields,
} = require('../utils/profile-indexability');

const base = () => ({
  id: 123, email: 'a@b.ca', enriched_email: null, status: 'enriched',
  is_misclassified: null, has_enrichment_collision: false, is_generic_inbox: null,
  firm_name: 'Firm LLP', city: 'Toronto', generated_bio: 'A real bio.', designation: 'CPA, CA',
  static_page_at: null,
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
  assert.strictEqual(classifyProfile({ ...base(), dispute_pending: true }).reason, 'dispute_pending');
  assert.strictEqual(classifyProfile({ ...base(), removed_at: new Date() }).reason, 'removed');
  // gated wins even when the row is otherwise empty
  assert.strictEqual(classifyProfile({ is_generic_inbox: true }).http_status, 410);
});

test('a complete, ungated row is indexable, in the SPA tier until a static file exists', () => {
  assert.deepStrictEqual(classifyProfile(base()), { http_status: 200, indexable: true, reason: 'ok', tier: 'spa' });
  assert.deepStrictEqual(classifyProfile({ ...base(), static_page_at: '2026-10-05T00:00:00Z' }),
    { http_status: 200, indexable: true, reason: 'ok', tier: 'static' });
});

test('threshold: valid status, firm, city, and bio-or-designation. Email and phone are never required', () => {
  const noindex = (patch, reason) => {
    const r = classifyProfile({ ...base(), ...patch });
    assert.deepStrictEqual(r, { http_status: 200, indexable: false, reason }, JSON.stringify(patch));
  };
  noindex({ status: 'invalid' }, 'invalid_status');
  noindex({ firm_name: '' }, 'no_firm');
  noindex({ city: null }, 'no_city');
  noindex({ generated_bio: null, designation: ' ' }, 'no_bio_or_designation');
  // no address of any kind still qualifies (2026-10-05: the email clause was dropped)
  assert.strictEqual(classifyProfile({ ...base(), email: null, enriched_email: null }).indexable, true);
  assert.strictEqual(classifyProfile({ ...base(), email: '  ', enriched_email: '' }).indexable, true);
  // bio alone, or designation alone, satisfies the last clause
  assert.strictEqual(classifyProfile({ ...base(), designation: null }).indexable, true);
  assert.strictEqual(classifyProfile({ ...base(), generated_bio: null }).indexable, true);
  // phone is never required
  assert.strictEqual(classifyProfile({ ...base(), phone: null }).indexable, true);
  // a non-indexable row carries no tier
  assert.strictEqual(classifyProfile({ ...base(), city: null }).tier, undefined);
});

test('SQL predicate carries every clause of the threshold and no email or phone clause', () => {
  for (const frag of [
    "status IS DISTINCT FROM 'invalid'",
    'is_misclassified IS TRUE', 'has_enrichment_collision IS TRUE', 'is_generic_inbox IS TRUE',
    'dispute_pending IS TRUE', 'removed_at IS NOT NULL',
    "NULLIF(TRIM(firm_name), '') IS NOT NULL",
    "NULLIF(TRIM(city), '') IS NOT NULL",
    "NULLIF(TRIM(generated_bio), '') IS NOT NULL OR NULLIF(TRIM(designation), '') IS NOT NULL",
  ]) assert.ok(INDEXABLE_SQL.includes(frag), `missing clause: ${frag}`);
  assert.ok(!/phone/.test(INDEXABLE_SQL), 'phone must not be part of the threshold');
  assert.ok(!/email/.test(INDEXABLE_SQL), 'email must not be part of the threshold (dropped 2026-10-05)');
  assert.strictEqual(STATIC_TIER_SQL, 'static_page_at IS NOT NULL');
  assert.strictEqual(SPA_TIER_SQL, 'static_page_at IS NULL');
  // email columns stay in the SELECT list so withPublicIndexFields keeps stripping them
  for (const col of ['email', 'enriched_email', 'status', 'firm_name', 'city', 'generated_bio', 'designation', 'static_page_at'])
    assert.ok(INDEXABILITY_COLUMNS.split(', ').includes(col), `INDEXABILITY_COLUMNS lacks ${col}`);
});

test('canonical page location follows the delivery tier', () => {
  assert.strictEqual(staticPath(42), '/profile/42/');
  assert.strictEqual(spaPath(42), '/profile?id=42');
  // a bare id is the generator writing that id's static file
  assert.strictEqual(tierOf(42), 'static');
  assert.strictEqual(profilePath(42), '/profile/42/');
  assert.strictEqual(profileUrl(42), 'https://canadaaccountants.app/profile/42/');
  // a row decides by static_page_at
  assert.strictEqual(profilePath({ id: 42, static_page_at: null }), '/profile?id=42');
  assert.strictEqual(profileUrl({ id: 42, static_page_at: null }), 'https://canadaaccountants.app/profile?id=42');
  assert.strictEqual(profilePath({ id: 42, static_page_at: '2026-10-05' }), '/profile/42/');
});

test('withPublicIndexFields strips private columns and attaches the tiered profile_url only when indexable', () => {
  const pub = withPublicIndexFields({ ...base(), full_name: 'A B' });
  assert.strictEqual(pub.email, undefined);
  assert.strictEqual(pub.enriched_email, undefined);
  assert.strictEqual(pub.status, undefined);
  assert.strictEqual(pub.is_misclassified, undefined);
  assert.strictEqual(pub.generated_bio, undefined);
  assert.strictEqual(pub.static_page_at, undefined);
  assert.strictEqual(pub.firm_name, 'Firm LLP');
  assert.strictEqual(pub.indexable, true);
  assert.strictEqual(pub.profile_url, '/profile?id=123');
  const statik = withPublicIndexFields({ ...base(), static_page_at: '2026-10-05' });
  assert.strictEqual(statik.profile_url, '/profile/123/');
  const held = withPublicIndexFields({ ...base(), city: null });
  assert.strictEqual(held.indexable, false);
  assert.strictEqual(held.profile_url, null);
});

test('server.js reads the rule through the module: sitemap, related, directory, profile API', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("require('./utils/profile-indexability')"), 'server.js must require the module');
  // The retired ad-hoc filter (email-only, hardcoded URL form) must not come back in the sitemap route.
  const sitemap = src.slice(src.indexOf("app.get('/api/sitemap-profiles.xml'"), src.indexOf('async function readLiveSitemapIds'));
  assert.ok(sitemap.includes('INDEXABLE_SQL'), 'sitemap route must filter with INDEXABLE_SQL');
  assert.ok(sitemap.includes('STATIC_TIER_SQL') && sitemap.includes('SPA_TIER_SQL'), 'sitemap route must offer both tiers');
  assert.ok(!sitemap.includes('<loc>https://canadaaccountants.app/profile'), 'sitemap must take every profile URL from profileUrl(row), never a literal');
  assert.ok(sitemap.includes('profileUrl(row)'), 'sitemap must pass the row so the tier decides the form');
  assert.ok(!sitemap.includes('email'), 'sitemap route must not reintroduce an email filter');
  const profile = src.slice(src.indexOf("app.get('/api/profiles/:id'"), src.indexOf('// ── Public Directory Endpoints'));
  assert.ok(profile.includes('classifyProfile('), 'profile API must expose the indexable flag');
  assert.ok(profile.includes('delivery_tier'), 'profile API must expose the delivery tier');
  assert.ok(profile.includes('INDEXABLE_SQL'), 'related profiles must be filtered to indexable rows');
  assert.ok(profile.includes('static_page_at') && profile.includes('profilePath(r)'), 'related links must be tiered by row');
  const directory = src.slice(src.indexOf("app.get('/api/directory/city/:city'"), src.indexOf('// Founder outreach: weekly digest'));
  assert.strictEqual((directory.match(/GATED_SQL/g) || []).length, 7, 'all 3 directory endpoints filter gated rows in list + count queries, plus the province designation counts');
  // Boot-time schema guard for the tier column
  assert.ok(src.includes('ADD COLUMN IF NOT EXISTS static_page_at TIMESTAMPTZ'), 'server.js must ensure the static_page_at column on boot');
  // The generator and the API agree on where a static file lives
  const gen = fs.readFileSync(path.join(__dirname, '..', 'tools', 'tier1-pregen', 'gen-db.js'), 'utf8');
  assert.ok(gen.includes('static_page_at'), 'gen-db.js must align static_page_at with the files it writes');
  assert.ok(gen.includes("'sitemap-spa'") && gen.includes("'sitemap-profiles'"), 'gen-db.js must write both sitemap families');
});
