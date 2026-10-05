// Single source of truth for "is this scraped_cpas row a public, indexable profile page?"
// and "at which URL does that page live?"
//
// Every path that decides whether a profile is public reads THIS module, so the page
// generator, the sitemap generator, the profile API, the directory listings and the
// related-profiles block can never disagree about which ids exist on the site:
//   - INDEXABLE_SQL         WHERE-clause predicate (unaliased scraped_cpas columns)
//   - INDEXABILITY_COLUMNS  the columns classifyProfile() needs; add to any SELECT
//   - classifyProfile(row)  the same rule in JS, returning the HTTP status the page URL
//                           should carry: 404 (absent), 410 (gated), 200 (+ indexable flag)
//                           and, for indexable rows, the delivery tier ('static' | 'spa')
//   - profilePath / profileUrl  canonical page location for a row (or a bare id)
//
// Threshold (OPERATIONS.md, 2026-10-05 two-tier admission; supersedes the 2026-09-07 item B):
//   indexable = exists AND not gated AND status <> 'invalid'
//               AND firm_name AND city present AND (bio OR designation)
// An email address is deliberately NOT required (dropped 2026-10-05). Indexing eligibility
// never depended on contact-info enrichment: the page shows name, designation, firm and
// city, none of which come from the email. The LAW sitemap made the same call on
// 2026-06-01 (6,250 -> 134,924 eligible) and that corpus is what Google rewards; on ACC the
// clause alone held back 91,727 of 101,935 rows (BP-010 count, 2026-09-07). Phone is
// likewise NOT required (null on ~100% of rows).
// Gated = is_misclassified OR has_enrichment_collision OR is_generic_inbox (the three
// pool-contamination flags) OR dispute_pending OR removed_at (the person asked for a
// correction or removal: services/profile-disputes.js). All five are what
// /api/profiles/:id and /api/claim/profile/:refToken refuse with 410.
//
// Delivery tier (2026-10-05). GitHub Pages serves two kinds of profile URL and both are
// indexable; the row says which one is canonical for it:
//   static  /profile/{id}/      a pre-generated file exists (tools/tier1-pregen/gen-db.js).
//                               scraped_cpas.static_page_at is set by the generator in the
//                               same run that writes the file, cleared when it prunes it.
//   spa     /profile?id={id}    no file; the single-page profile.html renders from the API,
//                               self-canonicalises when indexable=true, and injects robots
//                               noindex on 404/410/indexable=false. This is the LAW model.
// The static tier is capped by the host (GitHub Pages ~1 GB); the spa tier costs nothing,
// so every indexable row that has no file is listed in the spa sitemap shards
// (sitemap-spa-N.xml) and linked at its ?id= URL. The SPA still redirects ?id= -> static
// when a file exists, so a stale link never lands on the wrong form.
//
// The SQL and the JS below MUST stay in lockstep; tests/profile-indexability.test.js
// pins both to the threshold above.

const SITE = 'https://canadaaccountants.app';

const GATED_SQL =
  '(is_misclassified IS TRUE OR has_enrichment_collision IS TRUE OR is_generic_inbox IS TRUE' +
  ' OR dispute_pending IS TRUE OR removed_at IS NOT NULL)';

// Kept for callers that still want "has any address" (outreach, claim flow). NOT part of
// the indexability threshold.
const HAS_EMAIL_SQL =
  "(NULLIF(TRIM(enriched_email), '') IS NOT NULL OR NULLIF(TRIM(email), '') IS NOT NULL)";

const INDEXABLE_SQL =
  "(status IS DISTINCT FROM 'invalid'" +
  ` AND NOT ${GATED_SQL}` +
  " AND NULLIF(TRIM(firm_name), '') IS NOT NULL" +
  " AND NULLIF(TRIM(city), '') IS NOT NULL" +
  " AND (NULLIF(TRIM(generated_bio), '') IS NOT NULL OR NULLIF(TRIM(designation), '') IS NOT NULL))";

// Tier predicates, for sitemap shards and counts. Both imply INDEXABLE_SQL when ANDed with it.
const STATIC_TIER_SQL = 'static_page_at IS NOT NULL';
const SPA_TIER_SQL = 'static_page_at IS NULL';

// email / enriched_email stay in this list although the rule no longer reads them: every
// public list response is built with withPublicIndexFields(), which strips exactly these
// columns, so leaving them here keeps addresses out of public JSON.
const INDEXABILITY_COLUMNS =
  'email, enriched_email, status, is_misclassified, misclassified_reason, ' +
  'has_enrichment_collision, is_generic_inbox, dispute_pending, removed_at, firm_name, city, generated_bio, designation, ' +
  'static_page_at';

const INDEXABILITY_COLUMN_LIST = INDEXABILITY_COLUMNS.split(',').map(s => s.trim());

const present = v => typeof v === 'string' && v.trim() !== '';

function gateReason(row) {
  // Dispute flags first: a removal request outranks the contamination flags.
  if (row.removed_at) return 'removed';
  if (row.dispute_pending === true) return 'dispute_pending';
  if (row.is_misclassified === true) return row.misclassified_reason || 'misclassified';
  if (row.has_enrichment_collision === true) return 'enrichment_collision';
  if (row.is_generic_inbox === true) return 'generic_inbox';
  return null;
}

// Which URL form is canonical for an indexable row. A bare id (number/string) is treated
// as static for backwards compatibility with generator call sites that are, by
// construction, writing the static file for that id.
function tierOf(rowOrId) {
  if (rowOrId === null || rowOrId === undefined) return 'spa';
  if (typeof rowOrId !== 'object') return 'static';
  return rowOrId.static_page_at ? 'static' : 'spa';
}

// Mirrors INDEXABLE_SQL exactly. Returns the status the PAGE URL should carry.
function classifyProfile(row) {
  if (!row) return { http_status: 404, indexable: false, reason: 'not_found' };
  const gate = gateReason(row);
  if (gate) return { http_status: 410, indexable: false, reason: gate };
  let reason = 'ok';
  if (row.status === 'invalid') reason = 'invalid_status';
  else if (!present(row.firm_name)) reason = 'no_firm';
  else if (!present(row.city)) reason = 'no_city';
  else if (!(present(row.generated_bio) || present(row.designation))) reason = 'no_bio_or_designation';
  const indexable = reason === 'ok';
  return indexable
    ? { http_status: 200, indexable: true, reason, tier: tierOf(row) }
    : { http_status: 200, indexable: false, reason };
}

const idOf = rowOrId => (typeof rowOrId === 'object' && rowOrId !== null) ? rowOrId.id : rowOrId;

function staticPath(id) { return `/profile/${id}/`; }
function spaPath(id) { return `/profile?id=${id}`; }

// Canonical page location. Accepts a row (tier read from static_page_at) or a bare id
// (static, see tierOf). Pass the row wherever one is available.
function profilePath(rowOrId) {
  const id = idOf(rowOrId);
  return tierOf(rowOrId) === 'static' ? staticPath(id) : spaPath(id);
}
function profileUrl(rowOrId) { return `${SITE}${profilePath(rowOrId)}`; }

// Strip the columns that classifyProfile() needs but public list responses must not expose
// (email addresses, flag columns), attaching the derived public fields instead.
function withPublicIndexFields(row) {
  const out = { ...row };
  for (const c of INDEXABILITY_COLUMN_LIST) {
    if (c === 'firm_name' || c === 'city' || c === 'designation') continue;
    delete out[c];
  }
  const cls = classifyProfile(row);
  out.indexable = cls.indexable;
  out.profile_url = cls.indexable ? profilePath(row) : null;
  return out;
}

module.exports = {
  SITE,
  GATED_SQL,
  HAS_EMAIL_SQL,
  INDEXABLE_SQL,
  STATIC_TIER_SQL,
  SPA_TIER_SQL,
  INDEXABILITY_COLUMNS,
  classifyProfile,
  tierOf,
  staticPath,
  spaPath,
  profilePath,
  profileUrl,
  withPublicIndexFields,
};
