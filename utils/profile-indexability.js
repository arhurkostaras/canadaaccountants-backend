// Single source of truth for "is this scraped_cpas row a public, indexable profile page?"
//
// Every path that decides whether a profile is public reads THIS module, so the page
// generator, the sitemap generator, the profile API, the directory listings and the
// related-profiles block can never disagree about which ids exist on the site:
//   - INDEXABLE_SQL         WHERE-clause predicate (unaliased scraped_cpas columns)
//   - INDEXABILITY_COLUMNS  the columns classifyProfile() needs; add to any SELECT
//   - classifyProfile(row)  the same rule in JS, returning the HTTP status the page URL
//                           should carry: 404 (absent), 410 (gated), 200 (+ indexable flag)
//   - profilePath / profileUrl  canonical page location (the static /profile/{id}/ path)
//
// Threshold (OPERATIONS.md, 2026-09-07 profile-index fix, item B):
//   indexable = exists AND not gated AND has email AND status <> 'invalid'
//               AND firm_name AND city present AND (bio OR designation)
// Phone is deliberately NOT required (it is null on ~100% of rows).
// Gated = is_misclassified OR has_enrichment_collision OR is_generic_inbox (the three
// pool-contamination flags) OR dispute_pending OR removed_at (the person asked for a
// correction or removal: services/profile-disputes.js). All five are what
// /api/profiles/:id and /api/claim/profile/:refToken refuse with 410.
// The SQL and the JS below MUST stay in lockstep; tests/profile-indexability.test.js
// pins both to the threshold above.

const SITE = 'https://canadaaccountants.app';

const GATED_SQL =
  '(is_misclassified IS TRUE OR has_enrichment_collision IS TRUE OR is_generic_inbox IS TRUE' +
  ' OR dispute_pending IS TRUE OR removed_at IS NOT NULL)';

const HAS_EMAIL_SQL =
  "(NULLIF(TRIM(enriched_email), '') IS NOT NULL OR NULLIF(TRIM(email), '') IS NOT NULL)";

const INDEXABLE_SQL =
  `(${HAS_EMAIL_SQL}` +
  " AND status IS DISTINCT FROM 'invalid'" +
  ` AND NOT ${GATED_SQL}` +
  " AND NULLIF(TRIM(firm_name), '') IS NOT NULL" +
  " AND NULLIF(TRIM(city), '') IS NOT NULL" +
  " AND (NULLIF(TRIM(generated_bio), '') IS NOT NULL OR NULLIF(TRIM(designation), '') IS NOT NULL))";

const INDEXABILITY_COLUMNS =
  'email, enriched_email, status, is_misclassified, misclassified_reason, ' +
  'has_enrichment_collision, is_generic_inbox, dispute_pending, removed_at, firm_name, city, generated_bio, designation';

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

// Mirrors INDEXABLE_SQL exactly. Returns the status the PAGE URL should carry.
function classifyProfile(row) {
  if (!row) return { http_status: 404, indexable: false, reason: 'not_found' };
  const gate = gateReason(row);
  if (gate) return { http_status: 410, indexable: false, reason: gate };
  let reason = 'ok';
  if (!(present(row.enriched_email) || present(row.email))) reason = 'no_email';
  else if (row.status === 'invalid') reason = 'invalid_status';
  else if (!present(row.firm_name)) reason = 'no_firm';
  else if (!present(row.city)) reason = 'no_city';
  else if (!(present(row.generated_bio) || present(row.designation))) reason = 'no_bio_or_designation';
  return { http_status: 200, indexable: reason === 'ok', reason };
}

function profilePath(id) { return `/profile/${id}/`; }
function profileUrl(id) { return `${SITE}${profilePath(id)}`; }

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
  out.profile_url = cls.indexable ? profilePath(row.id) : null;
  return out;
}

module.exports = {
  GATED_SQL,
  HAS_EMAIL_SQL,
  INDEXABLE_SQL,
  INDEXABILITY_COLUMNS,
  classifyProfile,
  profilePath,
  profileUrl,
  withPublicIndexFields,
};
