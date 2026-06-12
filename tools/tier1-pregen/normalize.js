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
const PROFILE_CITY_PROV = { calgary:'AB', edmonton:'AB', 'red deer':'AB', lethbridge:'AB', 'fort mcmurray':'AB',
  toronto:'ON', ottawa:'ON', mississauga:'ON', hamilton:'ON', london:'ON', 'thunder bay':'ON', brampton:'ON', markham:'ON', kitchener:'ON', windsor:'ON',
  vancouver:'BC', victoria:'BC', surrey:'BC', burnaby:'BC', kelowna:'BC', richmond:'BC',
  winnipeg:'MB', brandon:'MB', halifax:'NS', moncton:'NB', fredericton:'NB', "saint john":'NB',
  saskatoon:'SK', regina:'SK', montreal:'QC', 'montréal':'QC', laval:'QC', gatineau:'QC', "st. john's":'NL', "st johns":'NL', charlottetown:'PE' };
function resolveLocation(city, province) {
  let outCity = city || null;
  if (outCity && province) {
    const known = PROFILE_CITY_PROV[outCity.trim().toLowerCase()];
    if (known && known !== province) outCity = null;
  }
  return { city: outCity, province: province || null };
}
module.exports = { dedupeName, cleanBio, resolveLocation, PROFILE_CITY_PROV };
