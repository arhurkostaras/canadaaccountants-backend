// Tier-1 DB-direct generator: the ONE path that decides which /profile/{id}/ pages the frontend
// serves AND which indexable profiles are listed at their SPA (/profile?id=N) form instead.
// Pulls every row passing INDEXABLE_SQL (utils/profile-indexability.js, the same predicate the
// API, the sitemap route and the directory listings use), applies the EXACT /api/profiles/:id
// normalization (dedupeName/cleanBio/resolveLocation + the real calculateSEOScore), and in a single
// run: refreshes existing static pages, prunes pages whose profile no longer qualifies (gated ->
// 410 intent, below threshold -> held), optionally admits new qualifying ids to the static tier,
// writes the static sitemap from the very same set, writes the SPA sitemap from every other
// indexable id, and aligns scraped_cpas.static_page_at with the files it left on disk. Pages,
// sitemaps and the column therefore cannot drift apart; the frontend CI gate
// (scripts/check-sitemap-profiles.mjs) refuses any commit where the static set does, and
// GET /api/admin/profile-index-drift reads the rest between regens.
//
// Two tiers (2026-10-05): the static tier is capped by GitHub Pages (~1 GB; ~15 KB a page), the
// SPA tier is free. Default admission to the static tier is OFF; without --admit-new every newly
// qualifying id lands in the SPA sitemap, which is the LAW model that reached 134,924 URLs.
//
// Usage (from this dir; DB env comes from Railway):
//   railway run --service canadaaccountants-backend node gen-db.js                 # DRY RUN: plan only, no writes
//   railway run --service canadaaccountants-backend node gen-db.js --write         # refresh + prune + both sitemaps + column
//   railway run --service canadaaccountants-backend node gen-db.js --write --admit-new [--admit-limit N]
//        also generate static pages for qualifying ids with no page yet (NEW public content: run the
//        10-random spot-check gate on the sample this prints before committing). --admit-limit caps
//        how many are promoted per run (lowest ids first); the rest stay in the SPA tier.
//   --include-claimed   also rewrite claimed professionals' pages (carve-out lifted; needs Arthur's
//                       per-run approval, see CLAUDE.md "Generated content"). Default: never touched.
//   --out <dir>         frontend checkout to write into (default $TIER1_OUT or ~/projects/canadaaccountants)
const { Pool } = require('pg');
const fs = require('fs'), path = require('path');
const { calculateSEOScore } = require('../../services/ai');
const { buildPage } = require('./gen-ssr');
const { dedupeName, cleanBio, stripBioHeader, resolveLocation } = require('./normalize');
const { INDEXABLE_SQL, INDEXABILITY_COLUMNS, classifyProfile, staticPath, spaPath, SITE } = require('../../utils/profile-indexability');

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const optVal = (name, dflt) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const WRITE = flag('--write');
const ADMIT_NEW = flag('--admit-new');
const ADMIT_LIMIT = parseInt(optVal('--admit-limit', '0'), 10) || 0;
const INCLUDE_CLAIMED = flag('--include-claimed');
const OUT = optVal('--out', process.env.TIER1_OUT || '/Users/arthurkostaras/projects/canadaaccountants');
const PER_SITEMAP = 45000; // under Google's 50K cap
const MAX_SHARDS = 20;

const pub = process.env.DATABASE_URL.replace('@postgres.railway.internal:5432', '@turntable.proxy.rlwy.net:13986');

function assemble(p) {
  let firstName = p.first_name || '', lastName = p.last_name || '';
  if (firstName.includes(',') && !lastName) { const parts = firstName.split(',').map(s => s.trim()); lastName = parts[0]; firstName = parts[1] || ''; }
  const fullName = dedupeName(`${firstName} ${lastName}`.trim());
  const bio = stripBioHeader(cleanBio(p.generated_bio), [fullName, p.full_name, `${p.first_name || ''} ${p.last_name || ''}`.trim()]) || null;
  const seoScore = calculateSEOScore({ bio, phone: p.phone, specializations: p.specializations, firm_name: p.firm_name, designation: p.designation, city: p.city, province: p.province, years_experience: p.years_experience, claim_status: p.claim_status, subscription_tier: p.subscription_tier });
  const loc = resolveLocation(p.city, p.province);
  const location = [loc.city, loc.province].filter(Boolean).join(', ');
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'Person', name: fullName,
    jobTitle: p.designation ? `${p.designation} — Chartered Professional Accountant` : 'Chartered Professional Accountant',
    ...(p.firm_name && { worksFor: { '@type': 'Organization', name: p.firm_name } }),
    ...(location && { address: { '@type': 'PostalAddress', addressLocality: loc.city || '', addressRegion: loc.province || '', addressCountry: 'CA' } }),
    ...(bio && { description: bio }),
    // This function only ever builds the static file for p.id, so the static form is correct here.
    url: `${SITE}${staticPath(p.id)}`
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

// One sitemap family (static: sitemap-profiles-N.xml listing /profile/{id}/; spa: sitemap-spa-N.xml
// listing /profile?id={id}). Writes the shards, deletes stale extra shards, rewires
// sitemap_index.xml and robots.txt for exactly the shards written. Returns the shard count.
function writeShardFamily({ shardName, ids, pathFor, comment, alwaysOne }) {
  const today = new Date().toISOString().slice(0, 10);
  const shards = [];
  for (let i = 0; i < ids.length; i += PER_SITEMAP) shards.push(ids.slice(i, i + PER_SITEMAP));
  if (shards.length === 0 && alwaysOne) shards.push([]);
  shards.forEach((shard, i) => {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += `<!-- Generated ${today} by canadaaccountants-backend tools/tier1-pregen/gen-db.js: ${comment(ids.length)} Do not hand-edit. -->\n`;
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const id of shard) xml += `  <url><loc>${SITE}${pathFor(id)}</loc><changefreq>monthly</changefreq></url>\n`;
    xml += '</urlset>\n';
    fs.writeFileSync(path.join(OUT, `${shardName}-${i + 1}.xml`), xml);
  });
  // stale extra shards from a larger previous run
  for (let i = shards.length + 1; i <= MAX_SHARDS; i++) {
    const f = path.join(OUT, `${shardName}-${i}.xml`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  const shardRe = new RegExp(`${shardName}-\\d+\\.xml`);
  // sitemap_index.xml: replace this family's entries, refresh lastmod
  const idxPath = path.join(OUT, 'sitemap_index.xml');
  if (fs.existsSync(idxPath)) {
    let idx = fs.readFileSync(idxPath, 'utf8');
    idx = idx.replace(new RegExp(`\\s*<sitemap>\\s*<loc>[^<]*${shardName}-\\d+\\.xml<\\/loc>\\s*(<lastmod>[^<]*<\\/lastmod>\\s*)?<\\/sitemap>`, 'g'), '');
    const entries = shards.map((_, i) => `  <sitemap>\n    <loc>${SITE}/${shardName}-${i + 1}.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n`).join('');
    idx = idx.replace(/\s*<\/sitemapindex>/, `\n${entries}</sitemapindex>`);
    fs.writeFileSync(idxPath, idx);
  }
  // robots.txt: one Sitemap: line per shard
  const robotsPath = path.join(OUT, 'robots.txt');
  if (fs.existsSync(robotsPath)) {
    let robots = fs.readFileSync(robotsPath, 'utf8').split('\n').filter(l => !shardRe.test(l)).join('\n');
    const lines = shards.map((_, i) => `Sitemap: ${SITE}/${shardName}-${i + 1}.xml`).join('\n');
    robots = robots.replace(/\n*$/, '\n') + (lines ? lines + '\n' : '');
    fs.writeFileSync(robotsPath, robots);
  }
  return shards.length;
}

function writeSitemaps(staticIds, spaIds) {
  const staticShards = writeShardFamily({
    shardName: 'sitemap-profiles', ids: staticIds, pathFor: staticPath, alwaysOne: true,
    comment: n => `${n} profiles passing the indexability threshold (utils/profile-indexability.js) that have a static /profile/{id}/ page. CI (scripts/check-sitemap-profiles.mjs) requires 1:1 parity with /profile/{id}/index.html.`,
  });
  const spaShards = writeShardFamily({
    shardName: 'sitemap-spa', ids: spaIds, pathFor: spaPath, alwaysOne: false,
    comment: n => `${n} profiles passing the indexability threshold (utils/profile-indexability.js) served by the single-page profile.html at /profile?id=N (no static file; the page self-canonicalises). CI (scripts/check-sitemap-profiles.mjs) requires that none of these ids has a /profile/{id}/index.html.`,
  });
  return { staticShards, spaShards };
}

(async () => {
  const pool = new Pool({ connectionString: pub, ssl: { rejectUnauthorized: false }, max: 2 });
  pool.on('error', e => console.error('[gen-db] pool error:', e.message));
  const { rows } = await pool.query(`
    SELECT id, first_name, last_name, full_name, firm_name, city, province, designation, phone,
           generated_bio, claim_status, founding_member, static_page_at
    FROM scraped_cpas
    WHERE ${INDEXABLE_SQL}
    ORDER BY id`);
  const indexable = new Map(rows.map(r => [r.id, r]));
  const existing = existingPageIds();
  const existingSet = new Set(existing);

  const refresh = existing.filter(id => indexable.has(id));
  const admitAll = rows.map(r => r.id).filter(id => !existingSet.has(id));
  const admit = ADMIT_LIMIT > 0 ? admitAll.slice(0, ADMIT_LIMIT) : admitAll;
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

  // Column drift: rows whose static_page_at disagrees with the files on disk right now.
  const dbStatic = rows.filter(r => r.static_page_at).map(r => r.id);
  const colSetMissing = existing.filter(id => indexable.has(id) && !indexable.get(id).static_page_at).length;
  const colSetStale = dbStatic.filter(id => !existingSet.has(id)).length;

  const plannedStatic = refresh.length + (ADMIT_NEW ? admit.length - (INCLUDE_CLAIMED ? 0 : claimedAdmit.length) : 0);
  const plannedSpa = rows.length - plannedStatic - (INCLUDE_CLAIMED ? 0 : 0);

  console.log(`PLAN (${WRITE ? 'WRITE' : 'DRY RUN'}) out=${OUT}`);
  console.log(`  indexable in DB (threshold): ${rows.length}`);
  console.log(`  pages on disk now:           ${existing.length}`);
  console.log(`  refresh (on disk, qualifies): ${refresh.length}  [claimed, ${INCLUDE_CLAIMED ? 'INCLUDED' : 'skipped (carve-out)'}: ${claimedRefresh.length} -> ${first(claimedRefresh)}]`);
  console.log(`  prune (on disk, no longer qualifies): ${prune.length}  ${JSON.stringify(pruneByReason)}  e.g. ${first(prune)}`);
  if (claimedPrune.length) console.log(`  !! prune contains CLAIMED profiles, NEVER auto-deleted: ${claimedPrune.join(', ')}. They stay on disk but are excluded from the sitemap, so the CI parity gate will fail until resolved (fix the DB state or run --include-claimed with Arthur's approval).`);
  console.log(`  qualifies, no page yet: ${admitAll.length}${ADMIT_LIMIT ? ` (admit limited to first ${admit.length})` : ''}  [${ADMIT_NEW ? 'WILL GENERATE static pages' : 'SPA tier (pass --admit-new to promote)'}; no stored bio -> templated summary: ${noBioAdmit.length}; claimed: ${claimedAdmit.length}]  e.g. ${first(admitAll)}`);
  if (ADMIT_NEW && admit.length) console.log(`  spot-check sample (10 random of admit): ${sample(admit, 10).map(id => `${SITE}${staticPath(id)}`).join(' ')}`);
  console.log(`  static_page_at drift now: ${colSetMissing} on disk but column null, ${colSetStale} column set but no file (aligned on --write)`);
  console.log(`  sitemaps after run: static ${plannedStatic} urls in ${Math.max(1, Math.ceil(plannedStatic / PER_SITEMAP))} shard(s); spa ${Math.max(0, plannedSpa)} urls in ${Math.ceil(Math.max(0, plannedSpa) / PER_SITEMAP)} shard(s)`);

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
  const finalStatic = existingPageIds().filter(id => indexable.has(id));
  const finalStaticSet = new Set(finalStatic);
  const finalSpa = rows.map(r => r.id).filter(id => !finalStaticSet.has(id));
  const { staticShards, spaShards } = writeSitemaps(finalStatic, finalSpa);

  // Align the column with the files that now exist. Cleared first so a pruned id never
  // keeps the static form; claimed pages left on disk keep their flag (their file exists).
  const onDisk = existingPageIds();
  const cleared = await pool.query(`UPDATE scraped_cpas SET static_page_at = NULL WHERE static_page_at IS NOT NULL AND NOT (id = ANY($1::int[]))`, [onDisk]);
  const set = await pool.query(`UPDATE scraped_cpas SET static_page_at = NOW() WHERE id = ANY($1::int[]) AND static_page_at IS NULL`, [onDisk]);
  await pool.end();
  console.log(`DONE: written=${written} (refresh ${refresh.length - skippedClaimed}${ADMIT_NEW ? ` + admit ${admit.length - claimedAdmit.length + (INCLUDE_CLAIMED ? claimedAdmit.length : 0)}` : ''}) | claimed skipped=${skippedClaimed} | pruned=${pruned} | fail=${fail} | static sitemap=${finalStatic.length} urls / ${staticShards} shard(s) | spa sitemap=${finalSpa.length} urls / ${spaShards} shard(s) | static_page_at set=${set.rowCount} cleared=${cleared.rowCount}`);
  if (fail) { console.error('FAILED pages above: do not commit until resolved.'); process.exit(1); }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
