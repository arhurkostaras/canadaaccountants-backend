-- 002_referral_code_trigger.sql
-- Claim-time hook: every new row in the professional table gets a referral_code
-- at INSERT, generated in the database itself. ACC has FIVE separate
-- INSERT INTO cpa_profiles code paths (server.js lines ~200, 600, 4586, 5977,
-- 7319); an app-level hook on one of them leaves the other four as silent gaps
-- (the 2026-04-21 claim-side-effect failure class). A BEFORE INSERT trigger
-- covers every path, including future ones, by construction.
--
-- Platform note: this is the ACC instance (table cpa_profiles, prefix 'ACC-').
-- On LAW/INV/CBE, substitute the platform's pro table and prefix.
-- Idempotent: function is CREATE OR REPLACE; trigger is dropped-and-recreated
-- (drops only the object this file owns).

CREATE OR REPLACE FUNCTION set_referral_code_on_pro_insert() RETURNS trigger AS $$
DECLARE
  candidate TEXT;
  attempts  INT := 0;
BEGIN
  -- Respect an explicitly supplied code (e.g. a controlled import).
  IF NEW.referral_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  LOOP
    attempts := attempts + 1;
    -- 6 chars from the 32-char alphabet with no I/L/O/U, same as the
    -- generator in modules/referrals/service.js and the backfill script.
    SELECT 'ACC-' || string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (floor(random() * 32))::int + 1, 1), '')
      INTO candidate
      FROM generate_series(1, 6);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM cpa_profiles WHERE referral_code = candidate);
    IF attempts >= 10 THEN
      RAISE EXCEPTION 'referral_code generation failed after 10 attempts: expected a free ACC-XXXXXX code, found collisions every try; the code space (32^6) should make this impossible - investigate cpa_profiles.referral_code contents';
    END IF;
  END LOOP;
  NEW.referral_code := candidate;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cpa_profiles_referral_code ON cpa_profiles;
CREATE TRIGGER trg_cpa_profiles_referral_code
  BEFORE INSERT ON cpa_profiles
  FOR EACH ROW
  EXECUTE FUNCTION set_referral_code_on_pro_insert();
