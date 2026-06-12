// Tier-1b bio-gen pass: generate + PERSIST bios for the no-bio Tier-1 profiles so they become
// deterministic and join the corpus. Feeds CLEAN inputs to generateBio (deduped name, resolved
// city/province) and post-processes through cleanBio (designation vocab + markdown) — the same
// fixed pipeline as the rest of Tier 1. Throttled; callWithRetry handles Anthropic rate limits.
const { Pool } = require('pg');
const { generateBio } = require('../../services/ai');
const { dedupeName, cleanBio, resolveLocation } = require('./normalize');

const pub = process.env.DATABASE_URL.replace('@postgres.railway.internal:5432', '@turntable.proxy.rlwy.net:13986');
const CONC = 30;
const FALLBACK = 'Your AI bio is being generated';

(async () => {
  const pool = new Pool({ connectionString: pub, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(`
    SELECT id, first_name, last_name, firm_name, city, province, designation
    FROM scraped_cpas
    WHERE COALESCE(enriched_email,email) IS NOT NULL AND status <> 'invalid'
      AND (is_misclassified IS NOT TRUE) AND (has_enrichment_collision IS NOT TRUE) AND (is_generic_inbox IS NOT TRUE)
      AND (generated_bio IS NULL OR length(trim(generated_bio)) < 40)
    ORDER BY id`);
  console.log(`no-bio Tier-1 profiles: ${rows.length}`);
  let ok = 0, skip = 0, fail = 0;
  for (let i = 0; i < rows.length; i += CONC) {
    const batch = rows.slice(i, i + CONC);
    await Promise.all(batch.map(async p => {
      try {
        const fullName = dedupeName(`${p.first_name || ''} ${p.last_name || ''}`.trim());
        const loc = resolveLocation(p.city, p.province);
        const input = { id: p.id, is_misclassified: false, first_name: fullName, last_name: '', firm_name: p.firm_name, city: loc.city, province: loc.province, designation: p.designation };
        let bio = await generateBio(input, 'accountants');
        bio = cleanBio(bio);
        if (!bio || bio.includes(FALLBACK) || bio.trim().length < 60) { skip++; return; }
        await pool.query('UPDATE scraped_cpas SET generated_bio = $1 WHERE id = $2', [bio, p.id]);
        ok++;
      } catch (e) { fail++; if (fail <= 3) console.log('  fail id=' + p.id + ': ' + e.message); }
    }));
    if (i % 300 === 0) process.stdout.write(`  ...${i + batch.length}/${rows.length} (persisted=${ok} skip=${skip} fail=${fail})\n`);
  }
  await pool.end();
  console.log(`DONE: persisted=${ok} | skipped(gen-failed/short)=${skip} | fail=${fail} | of ${rows.length}`);
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
