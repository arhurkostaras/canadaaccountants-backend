# Tier-1 profile static pre-generation

Reproducible generator for the static `/profile/{id}/` pages (ACC frontend repo).

- `normalize.js` — exact `/api/profiles/:id` normalization (dedupeName, cleanBio, resolveLocation).
- `gen-ssr.js`   — `buildPage(data, id)`: renderProfile-equivalent lean page (external assets).
- `gen-db.js`    — DB-direct: pulls valid-email + stored-bio rows, applies normalize + `calculateSEOScore`
                   (services/ai), writes `<frontend>/profile/{id}/index.html`. (API path is rate-limited.)
- `gen-bios.js`  — Tier-1b: generate + persist bios for no-bio rows (Claude Haiku 4.5), same fixed pipeline.

Run from this dir via `railway run --service canadaaccountants-backend node gen-db.js`.
Parity gate: headless-render N live SPAs and diff title/meta/H1/bio/JSON-LD vs the templated files.
