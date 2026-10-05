-- Migration 006: profile delivery tier (two-tier indexable corpus, 2026-10-05)
--
-- The indexability threshold (utils/profile-indexability.js) no longer requires an
-- email address, so far more rows qualify than GitHub Pages can hold as static
-- /profile/{id}/ files. Indexable rows are therefore served in two tiers:
--   static  static_page_at IS NOT NULL  a generated file exists; canonical /profile/{id}/
--   spa     static_page_at IS NULL      no file; canonical /profile?id={id} (the LAW model)
--
-- static_page_at is owned by tools/tier1-pregen/gen-db.js: set for every id whose file it
-- wrote or kept, cleared for every id it pruned, in the same --write run. Between regens
-- POST /api/admin/profile-static-sync re-reads the live static sitemap shards and realigns
-- the column (bootstrap after this migration, or after a hand-fix on the frontend).
--
-- Column default is NULL, so ADD COLUMN is a catalog-only change (no rewrite of the
-- 100K-row scraped_cpas). Idempotent: applied on every boot by server.js and safe via psql.

ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS static_page_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_scraped_cpas_static_page
  ON scraped_cpas (id) WHERE static_page_at IS NOT NULL;
