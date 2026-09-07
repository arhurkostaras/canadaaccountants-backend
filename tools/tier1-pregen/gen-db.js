// Tier-1 DB-direct generator: the ONE path that decides which /profile/{id}/ pages the frontend
// serves. Pulls every row passing INDEXABLE_SQL (utils/profile-indexability.js, the same predicate
// the API, the sitemap route and the directory listings use), applies the EXACT /api/profiles/:id
// normalization (dedupeName/cleanBio/resolveLocation + the real calculateSEOScore), and in a single
// run: refreshes existing pages, prunes pages whose profile no longer qualifies (gated -> 410 intent,
// below threshold -> held), optionally admits new qualifying ids, and writes the served sitemap from
// the very same set. Pages and sitemap therefore cannot drift apart; the frontend CI gate
// (scripts/check-sitemap-profiles.mjs) refuses any commit where they do.
//
// Usage (from this dir; DB env comes from Railway):
//   railway run --service canadaaccountants-backend node gen-db.js                 # DRY RUN: plan only, no writes
//   railway run --service canadaaccountants-backend node gen-db.js --write         # refresh + prune + sitemap
//   railway run --service canadaaccountants-backend node gen-db.js --write --admit-new
//        also generate pages for qualifying ids with no page yet (NEW public content: run the
//        10-random spot-check gate on the sample this prints before committing)
//   --include-claimed   also rewrite claimed professionals' pages (carve-out lifted; needs Arthur's
//                       per-run approval, see CLAUDE.md "Generated content"). Default: never touched.
//   --out <dir>         frontend checkout to write into (default $TIER1_OUT or ~/projects/canadaaccountants)
const { Pool } = require('pg');
const fs = require('fs'), path = require('path');
const { calculateSEOScore } = require('../../services/ai');
const { buildPage } = require('./gen-ssr');
const { dedupeName, cleanBio, resolveLocation } = require('./normalize');
const { INDEXABLE_SQL, INDEXABILITY_COLUMNS, classifyProfile, profileUrl } = require('../../utils/profile-indexability');

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const WRITE = flag('--write');
const ADMIT_NEW = flag('--admit-new');
const INCLUDE_CLAIMED = flag('--include-claimed');
const outIdx = argv.indexOf('--out');
const OUT = outIdx !== -1 ? argv[outIdx + 1] : (process.env.TIER1_OUT || '/Users/arthurkostaras/projects/canadaaccountants');
const PER_SITEMAP = 45000; // under Google's 50K cap
const SITE = 'https://canadaaccountants.app';

const pub = process.env.DATABASE_URL.replace('@postgres.railway.internal:5432', '@turntable.proxy.rlwy.net:13986');

function assemble(p) {
  let firstName = p.first_name || '', lastName = p.last_name || '';
  if (firstName.includes(',') && !lastName) { const parts = firstName.split(',').map(s => s.trim()); lastName = parts[0]; firstName = parts[1] || ''; }
  const fullName = dedupeName(`${firstName} ${lastName}`.trim());
  const bio = cleanBio(p.generated_bio) || null;
  const seoScore = calculateSEOScore({ bio, phone: p.phone, specializations: p.specializations, firm_name: p.firm_name, designation: p.designation, city: p.city, province: p.province, years_experience: p.years_experience, claim_status: p.claim_status, subscription_tier: p.subscription_tier });
  const loc = resolveLocation(p.city, p.province);
  const location = [loc.city, loc.province].filter(Boolean).join(', ');
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'Person', name: fullName,
    jobTitle: p.designation ? `${p.designation} — Chartered Professional Accountant` : 'Chartered Professional Accountant',
    ...(p.firm_name && { worksFor: { '@type': 'Organization', name: p.firm_name } }),
    ...(location && { address: { '@type': 'PostalAddress', addressLocality: loc.city || '', addressRegion: loc.province || '', addressCountry: 'CA' } }),
    ...(bio && { description: bio }),
    url: profileUrl(p.id)
  };
  return { profile: { id: p.id, name: fullName, first_name: firstName, last_name: lastName, firm_name: p.firm_name, city: loc.city, province: loc.province, designation: p.designation, bio, claim_status: p.claim_status || 'unclaimed', claimed: p.claim_status === 'claimed', founding_member: p.founding_member || false }, seo_score: seoScore, structured_data: jsonLd };
}

const sample = (arr, n) => arr.slice().sort(() => Math.random() - 0.5).slice(0, n);
const first = (arr, n = 5) => arr.slice(0, n).join(', ') + (arr.length > n ? ', ...' : '');

function existingPageIds() {
  const dir = path.join(OUT, 'profile');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(d => /^\d+$/.test(d) && fs.existsSync(path.join(dir, d, 'index.html')))
    .map(Number).sort((a, b) => a - b);
}

function writeSitemaps(ids) {
  const today = new Date().toISOString().slice(0, 10);
  const shards = [];
  for (let i = 0; i < ids.length; i += PER_SITEMAP) shards.push(ids.slice(i, i + PER_SITEMAP));
  if (shards.length === 0) shards.push([]);
  shards.forEach((shard, i) => {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += `<!-- Generated ${today} by canadaaccountants-backend tools/tier1-pregen/gen-db.js: ${ids.length} profiles passing the indexability threshold (utils/profile-indexability.js). Do not hand-edit; CI (scripts/check-sitemap-profiles.mjs) requires 1:1 parity with /profile/{id}/index.html. -->\n`;
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const id of shard) xml += `  <url><loc>${profileUrl(id)}</loc><changefreq>monthly</changefreq></url>\n`;
    xml += '</urlset>\n';
    fs.writeFileSync(path.join(OUT, `sitemap-profiles-${i + 1}.xml`), xml);
  });
  // stale extra shards from a larger previous run
  for (let i = shards.length + 1; i <= 20; i++) {
    const f = path.join(OUT, `sitemap-profiles-${i}.xml`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  // sitemap_index.xml: replace the profile-sitemap entries, refresh lastmod
  const idxPath = path.join(OUT, 'sitemap_index.xml');
  if (fs.existsSync(idxPath)) {
    let idx = fs.readFileSync(idxPath, 'utf8');
    idx = idx.replace(/\s*<sitemap>\s*<loc>[^<]*sitemap-profiles-\d+\.xml<\/loc>\s*(<lastmod>[^<]*<\/lastmod>\s*)?<\/sitemap>/g, '');
    const entries = shards.map((_, i) => `  <sitemap>\n    <loc>${SITE}/sitemap-profiles-${i + 1}.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n`).join('');
    idx = idx.replace(/\s*<\/sitemapindex>/, `\n${entries}</sitemapindex>`);
    fs.writeFileSync(idxPath, idx);
  }
  // robots.txt: one Sitemap: line per shard
  const robotsPath = path.join(OUT, 'robots.txt');
  if (fs.existsSync(robotsPath)) {
    let robots = fs.readFileSync(robotsPath, 'utf8').split('\n').filter(l => !/sitemap-profiles-\d+\.xml/.test(l)).join('\n');
    const lines = shards.map((_, i) => `Sitemap: ${SITE}/sitemap-profiles-${i + 1}.xml`).join('\n');
    robots = robots.replace(/\n*$/, '\n') + lines + '\n';
    fs.writeFileSync(robotsPath, robots);
  }
  return shards.length;
}

(async () => {
  const pool = new Pool({ connectionString: pub, ssl: { rejectUnauthorized: false }, max: 2 });
  pool.on('error', e => console.error('[gen-db] pool error:', e.message));
  const { rows } = await pool.query(`
    SELECT id, first_name, last_name, full_name, firm_name, city, province, designation, phone,
           generated_bio, claim_status, founding_member
    FROM scraped_cpas
    WHERE ${INDEXABLE_SQL}
    ORDER BY id`);
  const indexable = new Map(rows.map(r => [r.id, r]));
  const existing = existingPageIds();
  const existingSet = new Set(existing);

  const refresh = existing.filter(id => indexable.has(id));
  const admit = rows.map(r => r.id).filter(id => !existingSet.has(id));
  const prune = existing.filter(id => !indexable.has(id));

  // Why each pruned page no longer qualifies (410 gated / 404 gone / held below threshold).
  const pruneRows = prune.length ? (await pool.query(
    `SELECT u.id, s.id IS NULL AS missing, s.claim_status, ${INDEXABILITY_COLUMNS.split(', ').map(c => 's.' + c).join(', ')}
     FROM unnest($1::int[]) u(id) LEFT JOIN scraped_cpas s ON s.id = u.id`, [prune])).rows : [];
  const pruneClass = new Map(pruneRows.map(r => [r.id, r.missing ? { http_status: 404, reason: 'not_found' } : classifyProfile(r)]));
  const pruneByReason = {};
  for (const [, c] of pruneClass) { const k = `${c.http_status}:${c.reason}`; pruneByReason[k] = (pruneByReason[k] || 0) + 1; }
  const claimedPrune = pruneRows.filter(r => r.claim_status === 'claimed').map(r => r.id);
  const claimedRefresh = refresh.filter(id => indexable.get(id).claim_status === 'claimed');
  const claimedAdmit = admit.filter(id => indexable.get(id).claim_status === 'claimed');
  const noBioAdmit = admit.filter(id => !(indexable.get(id).generated_bio || '').trim());

  console.log(`PLAN (${WRITE ? 'WRITE' : 'DRY RUN'}) out=${OUT}`);
  console.log(`  indexable in DB (threshold): ${rows.length}`);
  console.log(`  pages on disk now:           ${existing.length}`);
  console.log(`  refresh (on disk, qualifies): ${refresh.length}  [claimed, ${INCLUDE_CLAIMED ? 'INCLUDED' : 'skipped (carve-out)'}: ${claimedRefresh.length} -> ${first(claimedRefresh)}]`);
  console.log(`  prune (on disk, no longer qualifies): ${prune.length}  ${JSON.stringify(pruneByReason)}  e.g. ${first(prune)}`);
  if (claimedPrune.length) console.log(`  !! prune contains CLAIMED profiles, NEVER auto-deleted: ${claimedPrune.join(', ')}. They stay on disk but are excluded from the sitemap, so the CI parity gate will fail until resolved (fix the DB state or run --include-claimed with Arthur's approval).`);
  console.log(`  admit (qualifies, no page yet): ${admit.length}  [${ADMIT_NEW ? 'WILL GENERATE' : 'HELD (pass --admit-new)'}; no stored bio -> templated summary: ${noBioAdmit.length}; claimed: ${claimedAdmit.length}]  e.g. ${first(admit)}`);
  if (admit.length) console.log(`  spot-check sample (10 random of admit): ${sample(admit, 10).map(id => `${SITE}/profile/${id}/`).join(' ')}`);

  const plannedCount = refresh.length + (ADMIT_NEW ? admit.length - (INCLUDE_CLAIMED ? 0 : claimedAdmit.length) : 0);
  console.log(`  sitemap after run: ${plannedCount} urls in ${Math.max(1, Math.ceil(plannedCount / PER_SITEMAP))} shard(s)`);

  if (!WRITE) { console.log('DRY RUN: nothing written. Re-run with --write to apply.'); await pool.end(); return; }

  let written = 0, skippedClaimed = 0, fail = 0, pruned = 0;
  const targets = refresh.filter(id => INCLUDE_CLAIMED || indexable.get(id).claim_status !== 'claimed');
  skippedClaimed = refresh.length - targets.length;
  if (ADMIT_NEW) targets.push(...admit.filter(id => INCLUDE_CLAIMED || indexable.get(id).claim_status !== 'claimed'));
  for (const id of targets) {
    try {
      const html = buildPage(assemble(indexable.get(id)), id);
      const dir = path.join(OUT, 'profile', String(id));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html);
      written++;
    } catch (e) { fail++; console.error(`  fail id=${id}: ${e.message}`); }
  }
  const claimedPruneSet = new Set(claimedPrune);
  for (const id of prune) {
    if (claimedPruneSet.has(id)) continue;
    fs.rmSync(path.join(OUT, 'profile', String(id)), { recursive: true, force: true });
    pruned++;
  }
  const finalIds = existingPageIds().filter(id => indexable.has(id));
  const shards = writeSitemaps(finalIds);
  await pool.end();
  console.log(`DONE: written=${written} (refresh ${refresh.length - skippedClaimed}${ADMIT_NEW ? ` + admit ${admit.length - claimedAdmit.length + (INCLUDE_CLAIMED ? claimedAdmit.length : 0)}` : ''}) | claimed skipped=${skippedClaimed} | pruned=${pruned} | fail=${fail} | sitemap=${finalIds.length} urls / ${shards} shard(s)`);
  if (fail) { console.error('FAILED pages above: do not commit until resolved.'); process.exit(1); }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
