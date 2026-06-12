// Tier-1 DB-direct generator: pulls raw rows in one query (no rate-limited API), applies the EXACT
// /api/profiles/:id normalization (dedupeName/cleanBio/resolveLocation copied verbatim + the real
// calculateSEOScore from services/ai), and emits lean static pages via the shared buildPage template.
// Only profiles with a STORED generated_bio (deterministic -> parity-checkable; no-bio rows generate
// fresh non-deterministic bios on view, so they are skipped + counted).
const { Pool } = require('pg');
const { calculateSEOScore } = require('../../services/ai');
const { buildPage } = require('./gen-ssr');

const { dedupeName, cleanBio, resolveLocation } = require('./normalize');

const fs = require('fs'), path = require('path');
const OUT = '/Users/arthurkostaras/projects/canadaaccountants';
const pub = process.env.DATABASE_URL.replace('@postgres.railway.internal:5432', '@turntable.proxy.rlwy.net:13986');

function assemble(p) {
  let firstName = p.first_name || '', lastName = p.last_name || '';
  if (firstName.includes(',') && !lastName) { const parts = firstName.split(',').map(s => s.trim()); lastName = parts[0]; firstName = parts[1] || ''; }
  const fullName = dedupeName(`${firstName} ${lastName}`.trim());
  const bio = cleanBio(p.generated_bio);
  const seoScore = calculateSEOScore({ bio, phone: p.phone, specializations: p.specializations, firm_name: p.firm_name, designation: p.designation, city: p.city, province: p.province, years_experience: p.years_experience, claim_status: p.claim_status, subscription_tier: p.subscription_tier });
  const loc = resolveLocation(p.city, p.province);
  const location = [loc.city, loc.province].filter(Boolean).join(', ');
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'Person', name: fullName,
    jobTitle: p.designation ? `${p.designation} — Chartered Professional Accountant` : 'Chartered Professional Accountant',
    ...(p.firm_name && { worksFor: { '@type': 'Organization', name: p.firm_name } }),
    ...(location && { address: { '@type': 'PostalAddress', addressLocality: loc.city || '', addressRegion: loc.province || '', addressCountry: 'CA' } }),
    ...(bio && { description: bio }),
    url: `https://canadaaccountants.app/profile/${p.id}/`
  };
  return { profile: { id: p.id, name: fullName, first_name: firstName, last_name: lastName, firm_name: p.firm_name, city: loc.city, province: loc.province, designation: p.designation, bio, claim_status: p.claim_status || 'unclaimed', claimed: p.claim_status === 'claimed', founding_member: p.founding_member || false }, seo_score: seoScore, structured_data: jsonLd };
}

(async () => {
  const pool = new Pool({ connectionString: pub, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(`
    SELECT id, first_name, last_name, full_name, firm_name, city, province, designation, phone,
           generated_bio, claim_status, founding_member
    FROM scraped_cpas
    WHERE COALESCE(enriched_email,email) IS NOT NULL AND status <> 'invalid'
      AND (is_misclassified IS NOT TRUE) AND (has_enrichment_collision IS NOT TRUE) AND (is_generic_inbox IS NOT TRUE)
    ORDER BY id`);
  let ok = 0, skipNoBio = 0, fail = 0;
  for (const p of rows) {
    if (!p.generated_bio || p.generated_bio.trim().length < 40) { skipNoBio++; continue; }
    try {
      const data = assemble(p);
      const html = buildPage(data, p.id);
      const dir = path.join(OUT, 'profile', String(p.id));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html);
      ok++;
    } catch (e) { fail++; if (fail <= 3) console.log('  fail id=' + p.id + ': ' + e.message); }
  }
  await pool.end();
  console.log(`DONE: valid-email rows=${rows.length} | generated=${ok} | skipped(no/thin bio)=${skipNoBio} | fail=${fail}`);
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
