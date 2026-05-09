// Per-recipient profile merge-tag resolution for v2 supply sequence (ACC).
//
// Maps generic merge tags to scraped_cpas columns. Falls back to
// human-readable generic phrases when a column is null/empty so rendered
// templates never contain a literal {{tag}} or "undefined".

function buildTagMap(recipient) {
  const r = recipient || {};
  const firmOrDesig = r.firm_name || r.designation || 'your firm';
  const designation = r.designation || 'your designation';
  const geo = [r.city, r.province].filter(Boolean).join(', ') || 'your region';
  return {
    firm_name_or_designation: firmOrDesig,
    designation_or_firm_type: designation,
    service_line: 'your service line',
    practice_area_or_service_line: 'your service line',
    practice_area: 'your service line',
    firm_size_bucket: 'mid-sized',
    geography: geo
  };
}

function apply(template, recipient) {
  if (!template) return template;
  const map = buildTagMap(recipient);
  let out = template;
  for (const [k, v] of Object.entries(map)) {
    out = out.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), v);
  }
  return out;
}

module.exports = { apply, buildTagMap };
