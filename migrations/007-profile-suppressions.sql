-- Migration 007: profile suppression list (ACC privacy removal requests)
--
-- Purpose: once a public CPA profile is removed at the request of the person it
-- describes, it must never be re-created as a NEW scraped_cpas row by the
-- provincial-registry scrapers in sme-intelligence-backend (7 INSERT sites,
-- deduped only by name_hash = sha256(name + province)), an enrichment import,
-- or manual SQL. A soft-removed row (removed_at set) already blocks an exact
-- name_hash re-scrape, but not a name variant, a different province string, or
-- a re-insert after the row is ever hard-deleted.
--
-- Port of canadalawyers-backend migrations/005-profile-suppressions.sql, with
-- scraped_lawyers -> scraped_cpas and bar_number -> permit_number. sme-intelligence-
-- backend writes to this same Postgres instance (DB_MAP.md), so one BEFORE INSERT
-- trigger covers every insert path without touching each scraper. SECURITY DEFINER
-- so the check runs whichever role inserts.
--
-- Matching (any one is enough):
--   1. registry id (permit_number) equal, same province
--   2. any known e-mail equal to email / enriched_email
--   3. normalised name equal in either order AND province equal (or unknown on either side)
-- Name normalisation mirrors generateNameHash() in sme-intelligence-backend:
-- lower-case, letters a-z only. Every blocked insert is logged to
-- profile_suppression_hits.
--
-- Entries are added per request with an INSERT (no personal data lives in this file).
-- Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS profile_suppressions (
  id                  SERIAL PRIMARY KEY,
  subject_ref         VARCHAR(50)  NOT NULL,              -- groups name variants of one person, e.g. '2026-11-23/1'
  removed_profile_id  INTEGER,                            -- primary scraped_cpas.id at removal time
  removed_profile_ids INTEGER[]    NOT NULL DEFAULT '{}', -- every removed id for this subject
  registry_id         VARCHAR(100),                       -- provincial CPA permit / member number when known
  first_name          VARCHAR(255),
  last_name           VARCHAR(255),
  name_key            VARCHAR(255) NOT NULL,              -- ps_name_key(first || last)
  name_key_rev        VARCHAR(255) NOT NULL,              -- ps_name_key(last || first)
  province_code       VARCHAR(2),                         -- NULL = any province
  emails              TEXT[]       NOT NULL DEFAULT '{}', -- lower-case known addresses
  reason              VARCHAR(50)  NOT NULL DEFAULT 'removal_request',
  request_source      VARCHAR(50)  NOT NULL DEFAULT 'email',
  requested_at        TIMESTAMPTZ  NOT NULL,
  removed_at          TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_suppressions_name_prov
  ON profile_suppressions (name_key, COALESCE(province_code, '**'));
CREATE INDEX IF NOT EXISTS idx_profile_suppressions_rev   ON profile_suppressions (name_key_rev);
CREATE INDEX IF NOT EXISTS idx_profile_suppressions_rpid  ON profile_suppressions (removed_profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_suppressions_rpids ON profile_suppressions USING GIN (removed_profile_ids);
CREATE INDEX IF NOT EXISTS idx_profile_suppressions_ref   ON profile_suppressions (subject_ref);

CREATE TABLE IF NOT EXISTS profile_suppression_hits (
  id                  SERIAL PRIMARY KEY,
  suppression_id      INTEGER NOT NULL REFERENCES profile_suppressions(id) ON DELETE CASCADE,
  matched_on          VARCHAR(20) NOT NULL,               -- 'registry_id' | 'email' | 'name'
  attempted_source    VARCHAR(100),
  attempted_full_name VARCHAR(500),
  attempted_province  VARCHAR(50),
  attempted_email     VARCHAR(255),
  hit_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_profile_suppression_hits_sid ON profile_suppression_hits (suppression_id, hit_at);

-- letters-only lower-case key; identical to generateNameHash()'s normalisation
CREATE OR REPLACE FUNCTION ps_name_key(txt TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT regexp_replace(lower(txt), '[^a-z]', '', 'g')
$$;

-- province text in any of the shapes the scrapers use -> 2-letter code (NULL if unknown)
CREATE OR REPLACE FUNCTION ps_province_code(txt TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE ps_name_key(COALESCE(txt, ''))
    WHEN 'on' THEN 'ON' WHEN 'ont' THEN 'ON' WHEN 'ontario' THEN 'ON'
    WHEN 'qc' THEN 'QC' WHEN 'pq' THEN 'QC' WHEN 'quebec' THEN 'QC' WHEN 'qubec' THEN 'QC'
    WHEN 'bc' THEN 'BC' WHEN 'britishcolumbia' THEN 'BC' WHEN 'colombiebritannique' THEN 'BC'
    WHEN 'ab' THEN 'AB' WHEN 'alberta' THEN 'AB'
    WHEN 'sk' THEN 'SK' WHEN 'sask' THEN 'SK' WHEN 'saskatchewan' THEN 'SK'
    WHEN 'mb' THEN 'MB' WHEN 'man' THEN 'MB' WHEN 'manitoba' THEN 'MB'
    WHEN 'ns' THEN 'NS' WHEN 'novascotia' THEN 'NS'
    WHEN 'nb' THEN 'NB' WHEN 'newbrunswick' THEN 'NB' WHEN 'nouveaubrunswick' THEN 'NB'
    WHEN 'pe' THEN 'PE' WHEN 'pei' THEN 'PE' WHEN 'princeedwardisland' THEN 'PE'
    WHEN 'nl' THEN 'NL' WHEN 'nf' THEN 'NL' WHEN 'newfoundland' THEN 'NL' WHEN 'newfoundlandandlabrador' THEN 'NL' WHEN 'newfoundlandlabrador' THEN 'NL'
    WHEN 'yt' THEN 'YT' WHEN 'yukon' THEN 'YT'
    WHEN 'nt' THEN 'NT' WHEN 'nwt' THEN 'NT' WHEN 'northwestterritories' THEN 'NT'
    WHEN 'nu' THEN 'NU' WHEN 'nunavut' THEN 'NU'
    ELSE NULL END
$$;

-- Returns the matching suppression row for a candidate profile, or nothing.
CREATE OR REPLACE FUNCTION ps_find_suppression(
  p_first TEXT, p_last TEXT, p_full TEXT, p_province TEXT, p_email TEXT, p_email2 TEXT, p_registry_id TEXT
) RETURNS TABLE (suppression_id INTEGER, matched_on TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  k1 TEXT := ps_name_key(COALESCE(p_first, '') || COALESCE(p_last, ''));
  k2 TEXT := ps_name_key(COALESCE(p_full, ''));
  pc TEXT := ps_province_code(p_province);
  e1 TEXT := lower(NULLIF(btrim(COALESCE(p_email, '')), ''));
  e2 TEXT := lower(NULLIF(btrim(COALESCE(p_email2, '')), ''));
  rid TEXT := NULLIF(btrim(COALESCE(p_registry_id, '')), '');
BEGIN
  RETURN QUERY
  SELECT s.id,
         CASE
           WHEN rid IS NOT NULL AND s.registry_id IS NOT NULL AND s.registry_id = rid
                AND (s.province_code IS NULL OR pc IS NULL OR s.province_code = pc) THEN 'registry_id'
           WHEN (e1 IS NOT NULL AND e1 = ANY (s.emails)) OR (e2 IS NOT NULL AND e2 = ANY (s.emails)) THEN 'email'
           ELSE 'name'
         END
  FROM profile_suppressions s
  WHERE (rid IS NOT NULL AND s.registry_id IS NOT NULL AND s.registry_id = rid
         AND (s.province_code IS NULL OR pc IS NULL OR s.province_code = pc))
     OR (e1 IS NOT NULL AND e1 = ANY (s.emails))
     OR (e2 IS NOT NULL AND e2 = ANY (s.emails))
     OR (
          ((k1 <> '' AND k1 IN (s.name_key, s.name_key_rev)) OR (k2 <> '' AND k2 IN (s.name_key, s.name_key_rev)))
          AND (s.province_code IS NULL OR pc IS NULL OR s.province_code = pc)
        )
  ORDER BY 1
  LIMIT 1;
END
$$;

-- BEFORE INSERT guard on scraped_cpas: drop the row and log the attempt.
CREATE OR REPLACE FUNCTION ps_block_suppressed_cpa() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  hit RECORD;
BEGIN
  SELECT * INTO hit FROM ps_find_suppression(
    NEW.first_name, NEW.last_name, NEW.full_name, NEW.province,
    NEW.email, NEW.enriched_email, NEW.permit_number
  );
  IF hit.suppression_id IS NOT NULL THEN
    INSERT INTO profile_suppression_hits
      (suppression_id, matched_on, attempted_source, attempted_full_name, attempted_province, attempted_email)
    VALUES
      (hit.suppression_id, hit.matched_on, NEW.source,
       COALESCE(NEW.full_name, btrim(COALESCE(NEW.first_name, '') || ' ' || COALESCE(NEW.last_name, ''))),
       NEW.province, COALESCE(NEW.enriched_email, NEW.email));
    RAISE NOTICE 'profile_suppressions: blocked insert of % (%) source=% matched_on=% suppression_id=%',
      NEW.full_name, NEW.province, NEW.source, hit.matched_on, hit.suppression_id;
    RETURN NULL;  -- silently skip this row; the scraper's loop continues
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_ps_block_suppressed_cpa ON scraped_cpas;
CREATE TRIGGER trg_ps_block_suppressed_cpa
  BEFORE INSERT ON scraped_cpas
  FOR EACH ROW EXECUTE FUNCTION ps_block_suppressed_cpa();
