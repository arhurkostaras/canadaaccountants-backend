-- Warm Re-engagement v1 audience SELECT (ACC)
-- Campaign: outreach_campaigns.id = 10
-- Expected row count after 2026-05-19 hazard filter: 1,218 (was 1,220 at lockdown)
--
-- Filters applied (belt-and-suspenders against Phase A WS B flags):
--   - clicked at least once on a prior outreach_emails send
--   - claim_status != 'claimed'
--   - is_misclassified IS DISTINCT FROM true (Step 1 / WS A)
--   - has_enrichment_collision IS DISTINCT FROM true (WS B)
--   - is_generic_inbox IS DISTINCT FROM true (WS B)
--   - effective email NOT in outreach_unsubscribes
--   - effective email NOT shared across multiple unclaimed scraped_cpas rows
--     (added 2026-05-19 after cgf.com-class shared-inbox claim-hijack discovery)

SELECT DISTINCT
  sc.id AS recipient_id,
  COALESCE(NULLIF(sc.enriched_email,''), sc.email) AS recipient_email,
  sc.first_name,
  sc.last_name,
  sc.city,
  sc.province
FROM scraped_cpas sc
WHERE sc.id IN (
  SELECT DISTINCT recipient_id
  FROM outreach_emails
  WHERE clicked_at IS NOT NULL
)
AND sc.claim_status IS DISTINCT FROM 'claimed'
AND sc.is_misclassified IS DISTINCT FROM true
AND sc.has_enrichment_collision IS DISTINCT FROM true
AND sc.is_generic_inbox IS DISTINCT FROM true
-- 2026-05-19: defensive generic-pattern local-part filter. is_generic_inbox
-- missed cases like usainfo@anca.com and actuarial@puresearch.com during
-- canary review. This regex catches role/shared-inbox patterns the WS B
-- flag didn't tag.
AND LOWER(SPLIT_PART(COALESCE(NULLIF(sc.enriched_email,''), sc.email), '@', 1)) !~ '^[0-9]'
AND LOWER(SPLIT_PART(COALESCE(NULLIF(sc.enriched_email,''), sc.email), '@', 1)) !~ '^(info|contact|admin|sales|office|hello|inquir(y|ies)|enquir(y|ies)|reception|noreply|no-?reply|donotreply|support|customer(service|care)?|cs|hr|web|main|general|mail|services?|marketing|accounting|billing|accounts?|ap|ar|finance|ops|operations|actuarial|usainfo|generalinfo|team)([-_.]|$)'
AND LOWER(COALESCE(NULLIF(sc.enriched_email,''), sc.email)) NOT IN (
  SELECT LOWER(email) FROM outreach_unsubscribes
)
AND LOWER(COALESCE(NULLIF(sc.enriched_email,''), sc.email)) NOT IN (
  SELECT LOWER(COALESCE(NULLIF(enriched_email,''), email))
  FROM scraped_cpas
  WHERE claim_status IS DISTINCT FROM 'claimed'
    AND COALESCE(NULLIF(enriched_email,''), email) IS NOT NULL
  GROUP BY 1 HAVING COUNT(*) > 1
);
