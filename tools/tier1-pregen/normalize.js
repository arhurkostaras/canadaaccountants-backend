// Shared profile normalization — the EXACT logic from server.js /api/profiles/:id, factored out so
// every Tier-1 generator (page build + bio-gen) applies it identically. Reproducible, no drift.
function dedupeName(name) {
  if (!name) return name;
  return name.replace(/\s*\(([^)]+)\)/g, (m, inner) => {
    const rest = name.replace(m, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const innerL = inner.trim().toLowerCase();
    return innerL && rest.includes(innerL) ? '' : m;
  }).replace(/\s+/g, ' ').trim();
}
function cleanBio(bio) {
  if (!bio) return bio;
  let b = bio;
  b = b.replace(/Chartered General Accountant/gi, 'Certified General Accountant')
       .replace(/Chartered Management Accountant/gi, 'Certified Management Accountant');
  b = b.replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
       .replace(/^[-*]\s+/gm, '').replace(/`([^`]+)`/g, '$1').replace(/#/g, '');
  return b.replace(/\n{3,}/g, '\n\n').trim();
}
// Stored bios often open with a header line the page already renders as the H1 ("Jane Doe, CPA, CA"
// or just "Jane Doe") followed by a blank line. Strip it when the first line starts with one of the
// person's name forms, is short, and is not a sentence. Render-time only; stored bios are untouched.
// Found by the 2026-09-07 10-random spot-check (1,669 of 1,715 admitted bios, 1,113 of 6,111 live).
function stripBioHeader(bio, names) {
  if (!bio) return bio;
  const list = (Array.isArray(names) ? names : [names]).filter(n => typeof n === 'string' && n.trim());
  if (!list.length) return bio;
  const nl = bio.indexOf('\n');
  if (nl === -1) return bio;
  const first = bio.slice(0, nl).trim();
  if (first.length > 120 || /[.!?]$/.test(first)) return bio;
  const firstL = first.toLowerCase();
  if (!list.some(n => firstL.startsWith(n.trim().toLowerCase()))) return bio;
  return bio.slice(nl).replace(/^\s+/, '');
}
// GeoNames allowlist (bundled at the backend root) — same as server.js resolveLocation.
const CA_CITIES = require('../../ca-cities.json');
const CA_CITY_SET = {};
for (const _p in CA_CITIES) CA_CITY_SET[_p] = new Set(CA_CITIES[_p]);
function resolveLocation(city, province) {
  // Keep the city only if it is a real municipality of the (authoritative) province; else province-only.
  let outCity = city || null;
  if (outCity && province && CA_CITY_SET[province]) {
    if (!CA_CITY_SET[province].has(outCity.trim().toLowerCase())) outCity = null;
  }
  return { city: outCity, province: province || null };
}
module.exports = { dedupeName, cleanBio, stripBioHeader, resolveLocation };
