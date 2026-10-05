# Tier-1 profile static pre-generation

Reproducible generator for the static `/profile/{id}/` pages (ACC frontend repo, GitHub Pages).

- `normalize.js` — exact `/api/profiles/:id` normalization (dedupeName, cleanBio, resolveLocation).
- `gen-ssr.js`   — `buildPage(data, id)`: renderProfile-equivalent lean page (external assets).
                   Rows with no stored bio get a factual templated summary, never a spinner.
- `gen-db.js`    — THE regeneration path. DB-direct (the API is rate-limited): selects every row
                   passing `INDEXABLE_SQL` (`utils/profile-indexability.js`, shared with the API,
                   the sitemap route, directory listings and related links), then in one run
                   refreshes existing static pages, prunes pages that no longer qualify, optionally
                   admits new ids to the static tier, writes `sitemap-profiles-N.xml` (static tier)
                   and `sitemap-spa-N.xml` (every other indexable id, at `/profile?id=N`) plus
                   `sitemap_index.xml` + `robots.txt`, and aligns `scraped_cpas.static_page_at`
                   with the files it left on disk. Dry run by default.
- `gen-bios.js`  — Tier-1b: generate + persist bios for no-bio rows (Claude Haiku 4.5), same fixed pipeline.

## Two delivery tiers (2026-10-05)

The indexability threshold no longer requires an email address (see the header of
`utils/profile-indexability.js`: the LAW corpus proved registry-sourced profiles index and
earn traffic without one, and the clause alone held back 91,727 of 101,935 ACC rows). Far more
rows qualify than GitHub Pages can hold as files, so indexable rows are served in two tiers:

| tier   | row state                    | canonical URL        | listed in                | how it is served |
|--------|------------------------------|----------------------|--------------------------|------------------|
| static | `static_page_at IS NOT NULL` | `/profile/{id}/`     | `sitemap-profiles-N.xml` | pre-generated file (this generator) |
| spa    | `static_page_at IS NULL`     | `/profile?id={id}`   | `sitemap-spa-N.xml`      | `profile.html` renders from the API, self-canonicalises when `indexable:true` |

`static_page_at` is owned by `gen-db.js --write`. Between regens
`POST /api/admin/profile-static-sync` (dry run; `?execute=true` writes) realigns it from the live
static sitemap, and `GET /api/admin/profile-index-drift` reports `tier_mismatch`. The API, the
directory listings and the related-profiles block all emit the row's own form through
`profilePath(row)`, so no page ever links a SPA-tier id at a static path that has no file.

Promotion to the static tier is opt-in per run (`--admit-new`, optionally `--admit-limit N`,
lowest ids first). Without it, newly qualifying ids go straight into the SPA sitemap: that is the
LAW model that reached 134,924 URLs with zero storage.

## Why the page set IS the index status (GitHub Pages)

canadaaccountants.app is served by GitHub Pages: a static host with no rewrites, functions or
per-URL status control. The HTTP status of a profile URL is therefore decided by whether the
file exists: `/profile/{id}/` is 200 iff the id passed the threshold at the last regen, 404
otherwise (gated and absent ids alike; a static host cannot emit 410). The legacy `/profile?id=N`
SPA form always 200s, so it injects `<meta name="robots" content="noindex">` whenever the API
answers 404/410 or `indexable:false`, and redirects to the static page when one exists.

## Regen runbook

```bash
cd ~/projects/canadaaccountants-backend
npm run tier1:regen                          # dry run: refresh / prune / spa-tier counts, column drift, samples
npm run tier1:regen -- --write               # refresh static pages, prune, write BOTH sitemap families, align static_page_at
npm run tier1:regen -- --write --admit-new --admit-limit 2000   # also promote up to 2,000 ids to static pages
```

First run after migration 006 (bootstrap, no files change): the dry run reports every page on
disk as "on disk but column null"; `--write` fixes that in the same run that writes the SPA
sitemap. Then deploy the backend so the API starts emitting tiered URLs, and commit the frontend
(pages, both sitemap families, index, robots) together.

Rules the generator enforces (see `~/.claude/CLAUDE.md`, "Generated content"):
- Claimed professionals' pages are never rewritten or deleted without `--include-claimed`
  (per-run approval from Arthur).
- `--admit-new` produces NEW public content: run the 10-random spot-check on the sample the
  dry run prints before committing.
- Commit the regenerated `profile/` pages together with BOTH sitemap families. The frontend CI
  gate `scripts/check-sitemap-profiles.mjs` (BP-010) fails any commit where the static sitemap
  and the pages drift, where a SPA-tier id has a static file, or where index/robots are unwired.
- Drift read between regens: `GET /api/admin/profile-index-drift` (admin token) compares the live
  sitemap against the threshold right now.

Default output dir `~/projects/canadaaccountants`; override with `--out <dir>` or `TIER1_OUT`.
Parity gate (historic): headless-render N live SPAs and diff title/meta/H1/bio/JSON-LD vs the templated files.
