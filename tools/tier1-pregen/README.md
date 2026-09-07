# Tier-1 profile static pre-generation

Reproducible generator for the static `/profile/{id}/` pages (ACC frontend repo, GitHub Pages).

- `normalize.js` — exact `/api/profiles/:id` normalization (dedupeName, cleanBio, resolveLocation).
- `gen-ssr.js`   — `buildPage(data, id)`: renderProfile-equivalent lean page (external assets).
                   Rows with no stored bio get a factual templated summary, never a spinner.
- `gen-db.js`    — THE regeneration path. DB-direct (the API is rate-limited): selects every row
                   passing `INDEXABLE_SQL` (`utils/profile-indexability.js`, shared with the API,
                   the sitemap route, directory listings and related links), then in one run
                   refreshes existing pages, prunes pages that no longer qualify, optionally admits
                   new ids, and writes `sitemap-profiles-N.xml` + `sitemap_index.xml` + `robots.txt`
                   from the same set. Dry run by default.
- `gen-bios.js`  — Tier-1b: generate + persist bios for no-bio rows (Claude Haiku 4.5), same fixed pipeline.

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
npm run tier1:regen                          # dry run: prints refresh / prune / admit counts + samples
npm run tier1:regen -- --write               # refresh existing pages, prune, rewrite sitemap
npm run tier1:regen -- --write --admit-new   # also generate pages for newly qualifying ids
```

Rules the generator enforces (see `~/.claude/CLAUDE.md`, "Generated content"):
- Claimed professionals' pages are never rewritten or deleted without `--include-claimed`
  (per-run approval from Arthur).
- `--admit-new` produces NEW public content: run the 10-random spot-check on the sample the
  dry run prints before committing.
- Commit the regenerated `profile/` pages together with the sitemap files. The frontend CI gate
  `scripts/check-sitemap-profiles.mjs` (BP-010) fails any commit where they drift.
- Drift read between regens: `GET /api/admin/profile-index-drift` (admin token) compares the live
  sitemap against the threshold right now.

Default output dir `~/projects/canadaaccountants`; override with `--out <dir>` or `TIER1_OUT`.
Parity gate (historic): headless-render N live SPAs and diff title/meta/H1/bio/JSON-LD vs the templated files.
