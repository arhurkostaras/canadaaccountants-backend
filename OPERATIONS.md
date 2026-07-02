# CanadaAccountants Operations and Incident Log

This is the CanadaAccountants (ACC) operations and incident record. Scope is ACC
only: each personal platform keeps its own ops and incident log in its own repo
(CanadaLawyers, CanadaInvesting, and CanadaBusinessExits each maintain their own).
This is intentionally narrower than BACKPRESSURE_LEDGER.md, which is cross-platform
because it records shared discipline; an incident log is per-platform history, so
it stays ACC-only.

Isolation note: this is personal-platform work and must NOT be recorded in
~/phronisi-ops/OPERATIONS.md, which is Phronisi-only. This file is the sibling of
BACKPRESSURE_LEDGER.md, the version-controlled personal-platforms record it lives
alongside.

---

## 2026-06-07 - ACC duplicate backend: wonderful-surprise reduced to inert (Option A)

> CORRECTION (2026-06-07, later same day): the "inert / incomplete CRM schema"
> framing in this entry understated reality and was partly wrong about consumers.
> The WS Postgres holds a live 2.4M-row scraped dataset and the WS SME scraper is
> alive; consumers attach at the DB/env layer, not via the app domain a code grep
> can see. The original text below is preserved as the record of what was believed
> at the time. See the correcting entry "WS Postgres (maglev) is a redundant scrape
> duplicate" further down.

### Context
ACC had two live Railway backends auto-deploying the same GitHub repo
(arhurkostaras/canadaaccountants-backend, branch main):
- fulfilling-empathy / canadaaccountants-backend = production (domain
  canadaaccountants-backend-production-1d8f.up.railway.app, the BACKEND_URL the
  frontend uses).
- wonderful-surprise / canadaaccountants-backend = isolated inert orphan (domain
  canadaaccountants-backend-production.up.railway.app, no -1d8f).
Every push to main double-built both. The duplicate surfaced when a prepare-script
bug failed both builds at once.

### Stage 0 finding (read-only verification)
wonderful-surprise (WS) is isolated and was never harmful:
- Own database (switchback.proxy.rlwy.net:20584/railway), a different host from
  production (postgres.railway.internal:5432/railway). Not shared.
- No RESEND_API_KEY (and no ZeroBounce, Stripe, or webhook secrets). Structurally
  cannot send email.
- WS database has an incomplete CRM schema (relation "crm_sequence_enrollments"
  does not exist), so the sequence scheduler errored on every tick.
- Evidence: the scheduler ticked every 15 minutes, but the email path
  short-circuited ("RESEND_API_KEY not set. Would send ... WEBHOOK HEALTH") to an
  admin alert only, never a real recipient. No real email was sent.
- No production-data writes possible (separate DB; the A3 prod-write check was
  skipped per the isolation finding).
- No live consumers (zero non-health inbound in the retained log window).
- No Stripe or Resend webhook points at the WS domain (all route to the -1d8f
  production backend and the other platforms). WS holds no canonical
  bounce or unsubscribe data.
Branch verdict: safe (isolated inert orphan).
Confidence bound: direct log evidence covers the retained log window, which began
at approximately 2026-06-07 08:06 UTC (the earliest retained log line) and ran
through the time of verification. Pre-window certainty rests on durable facts (no
Resend identity, incomplete CRM schema, separate DB), not logs.

### Step 2 (done) - remove the only WS reference in the frontend
The single source reference to the WS domain was a stale, never-served copy at
js/matching-engine.js (repo root). Firebase serves the public/ tree, so the root
file was never served, and it is not the same as public/js/matching-engine.js (a
different, non-WS copy that no page loads). Deleted the root file.
- Repo: arhurkostaras/canadaaccountants (frontend). Merge commit a4e5d7d
  (--no-ff); deletion commit e2f9df3. A 256-line deletion of one file.
- Source-only: no Firebase deploy was run (this repo has no CI deploy; deploys
  are manual). The live site is unchanged by design, because the deleted file was
  never served.
- Result: zero references to canadaaccountants-backend-production.up.railway.app
  anywhere in the repo (root and public/).

### Step 1 (done) - stop the double-build
Disabled "Auto deploys when pushed to GitHub" on wonderful-surprise /
canadaaccountants-backend (serviceId da3bd205-8c7b-4edf-8894-e3787aa6a227) via the
Railway dashboard. This is narrower than a full source disconnect: the repo stays
connected and manual deploys are still possible; only push-triggered autodeploy is
off. fulfilling-empathy was not touched.
- Rollback: re-enable the "Auto deploys" toggle in WS Settings.

### Static verification (read-only, against captured baselines)
- WS running image untouched: latestDeployment da969245 (SUCCESS, commit d81d0fd),
  /health 200.
- FE untouched: latestDeployment 000fdd4f (SUCCESS, commit d81d0fd), /health 200,
  source still connected, prod repo dir still linked to fulfilling-empathy.

### Proof (satisfied 2026-06-07)
The "one FE build, zero WS builds" check is satisfied. The commit that added this
record (66802a4) was the genuine backend push used as the test, so no throwaway
commit was created. Result: FE built 66802a4 and went green (deployment 4aebf747,
status SUCCESS, /health 200), while WS stayed at deployment da969245 with no build
triggered (still commit d81d0fd, /health 200). The autodeploy-disable on
wonderful-surprise is functionally proven; the double-build is dead.

### Still open (logged, not done)
- Full WS decommission (the WS canadaaccountants-backend service, its Postgres,
  and its sme-intelligence-backend) as a later pass, after confirming the WS
  sme-intelligence-backend's purpose and that nothing depends on it.
- Dead-but-served public/js/matching-engine.js (loaded by nothing; not a WS
  reference, so out of Option A scope). Optional hygiene removal plus a manual
  firebase deploy if ever actioned.
- Root vs public/ tree duplication (34 root *.html vs 15 in public/). Stale
  source duplication; worth a separate audit.

### Backpressure candidates (surfaced from live operation, not yet ledger rows)
No target architecture has been chosen yet, so these are candidates only:
1. One-platform-one-canonical-backend, with no hardcoded backend URLs in the
   frontend. The WS duplicate plus the hardcoded WS URL in matching-engine.js is
   how this defect persisted unseen.
2. Root vs public/ tree drift: two copies of the same asset, only one served,
   diverging silently.

---

## 2026-06-07 (later same day) - CORRECTION: WS Postgres (maglev) is a redundant scrape duplicate, NOT the four-platform demand side

Verification note: figures below are CC-measured this session UNLESS marked
[operator-supplied]. The fulfilling-empathy production DB (dd9a08) figures are
operator/dashboard reads: CC could NOT connect to it this session (the public
proxy turntable.proxy.rlwy.net:13986 returned "password authentication failed"),
so CC did not independently measure dd9a08's row counts or schema. All maglev and
accurate-ambition figures, the three system_identifiers, the service/project IDs,
and the backup hash are CC-measured.

### What triggered the correction
The WS decommission was paused, then cancelled, when the operator stated the WS
Postgres was "the demand side for all four platforms." That claim required
verification before any deletion. Investigation resolved it.

### The true database topology (three distinct Postgres instances)
- accurate-ambition Postgres (switchback.proxy.rlwy.net:20584, project 85fc2f19,
  service c435b148, system_identifier 7529571790925643812): the WS ACC backend's
  DB, reached CROSS-PROJECT from wonderful-surprise. Near-empty ACC schema (about
  2 users, trivial test data; row counts are pg_stat estimates). Separate project,
  OUT OF SCOPE for any WS retirement.
- wonderful-surprise Postgres "maglev" (maglev.proxy.rlwy.net:38500, project
  fb4795a2, service a2164d8c, system_identifier 7533302060726231076, PostgreSQL
  16.8): scraped_smes 2,413,950; scraped_cpas 96,119; market_data 7,890;
  scrape_jobs 1,219 (CC-measured, exact counts). Written to actively: latest
  scrape_jobs.started_at 2026-06-07 12:00, scraped_cpas enrichment 2026-06-07
  13:35, market_data 2026-06-07 06:00 (same day); scraped_smes latest 2026-06-05.
  Sole DB-layer consumer is the WS sme-intelligence-backend instance.
- fulfilling-empathy production Postgres "dd9a08" (turntable.proxy.rlwy.net:13986):
  the LIVE serving database. [operator-supplied] scraped_smes 2,579,637;
  scraped_cpas 100,060; PLUS the full application schema (users, matches,
  referrals, cpa_profiles, client_profiles, outreach_*, sequence_*,
  stripe_transactions, etc.). Served to platforms via the -5185 SME API. CC could
  not connect this session; these are dashboard reads, not CC-measured.

### Corrected facts vs the original Option A entry
- "WS is inert / dead": WRONG in part. The WS SME backend's HTTP returns 502, but
  its background SCRAPER is alive and writing maglev (same-day scrape_jobs and
  enrichment timestamps confirm it). It is a live, redundant scraper, not a dead
  service.
- "incomplete CRM schema, inert": UNDERSTATED. The original entry described only
  the absence of CRM tables on the WS ACC DB and missed the maglev dataset
  entirely. maglev holds a 2.4M-row live scraped dataset.
- "no live consumers": correct at the APP-DOMAIN layer (no repo references the WS
  domains) but the original reasoning was unsafe: it grepped code for the WS domain
  and could not see DB-layer / env-var consumers. The complete DB-layer consumer
  sweep this session (by host and by password fingerprint across all
  personal-platform projects, Phronisi excluded per isolation) found maglev is read
  only by the WS SME scraper instance; no platform backend connects to it by any
  variable.

### The actual demand-side data flow (established)
Platforms that use SME data (canadainvesting-backend, canadalawyers-backend,
lawyer-intelligence-backend) consume it via the live -5185 SME API
(sme-intelligence-backend-production-5185.up.railway.app), which reads dd9a08 (FE
production). ACC and CBE call no SME API (CC-verified by repo grep). maglev is an
INDEPENDENT, parallel scrape read by nobody downstream. There is no replication or
sync between maglev and dd9a08 (CC-confirmed in the sme-intelligence-backend repo:
a single DATABASE_URL client per instance, no sync logic; both SME instances run
the same repo bound to different DBs).

### Verdict
maglev is a REDUNDANT, TRAILING duplicate of production demand data. On the
operator-supplied dd9a08 figures, production (2,579,637 / 100,060) is LARGER than
maglev (2,413,950 / 96,119) and presumably fresher. The operator's instinct that
this data is critical was directionally right but identified the wrong copy: the
live demand side is dd9a08, not maglev. The conclusion that maglev's contents all
exist in fuller form in dd9a08 rests on the operator-supplied dd9a08 counts; CC did
not row-compare the two databases (could not read dd9a08). On that basis the WS SME
scraper is a duplicate pipeline doing the same scrape work for a database nothing
reads.

### Status and open items
- Decommission: cancelled as originally scoped; reframed as a future low-stakes
  pass = stop the redundant WS SME scraper, then retire the WS project. Not
  executed. If the redundancy holds (pending the dd9a08 superset confirmation
  above), retirement is low-risk once confirmed.
- Backups:
  - maglev: VALIDATED. Custom-format dump, 208M, sha256
    44e44a4eb5a732fd0975b1787546e221d3a0247e649a83e0f8a024f84cb88558, at
    ~/cc-backups/2026-06-07/wonderful-surprise-postgres/railway.dump, test-restored
    with exact row-count match on all four data tables. Single LOCAL copy only;
    NEEDS a second off-machine copy.
  - accurate-ambition Postgres: NOT backed up (the approved Stage 1b never ran
    after the pivot). Tiny; back up before any future action involving WS ACC.
  - dd9a08 (PRODUCTION): NO session backup exists, and CC could not connect to it.
    This is the real exposure: the live demand-and-operational DB (also holds users
    and stripe_transactions per the operator-supplied schema) has no fresh
    validated dump. Highest-priority backup target; CC needs working credentials or
    a dashboard-side dump to address it.
- Two scrapers run the same scrape against the same sources (one feeds dd9a08, one
  feeds the unread maglev): wasteful compute and duplicate target-site load.

### Lesson (backpressure candidate, not yet a ledger row)
Infra-dependency mapping must be done by database identity (system_identifier) and
env-var fingerprint, NEVER by code grep alone. A code grep declared WS an "isolated
orphan"; the truth (cross-project DB reach, a live scraper, a 2.4M-row dataset) was
only visible at the DB/env layer. This blind spot appeared TWICE this session (WS
ACC reaching cross-project into accurate-ambition, and the maglev scare) and nearly
drove deletion of data that looked deletable. Strongest ledger candidate from this
session; encode once a target convention is chosen.

---

## 2026-06-07 - Production database had zero backups: discovered and remediated

Verification note: the backup actions below were operator-performed via the Railway
dashboard; no credentials were surfaced to any agent. CC could NOT independently
verify the manual backup or the schedules: the Railway CLI exposes no
backup-schedule data (railway volume list shows only storage and mount path;
status --json shows only deployment cronSchedule, all null). Every backup fact in
this entry is therefore operator-reported, not CC-confirmed. The dd9a08 row-count
and schema references remain operator-supplied, as in the prior entry.

### What was found
While closing the dd9a08 backup item, a Railway dashboard check (operator-performed,
no credentials surfaced) found that the fulfilling-empathy production Postgres
(dd9a08 / turntable.proxy.rlwy.net:13986, the live serving and operational DB
holding users, stripe_transactions, matches, and the demand-side scraped data) had
NO backups and NO backup schedule at all. Not stale backups: none, and no schedule.
This is the most serious finding of the session, larger than the WS cleanup that
started it. The earlier log wording ("no session backup") understated it: the true
state was zero backup protection on live production data.

### Root cause
Railway Postgres services do not auto-configure backups by default, and none of the
operator's Postgres services had a schedule set. The assumption that production was
being auto-backed-up was false.

### Remediation (operator-reported; all via Railway dashboard, no credentials surfaced to any agent)
- dd9a08 (production, fulfilling-empathy): manual backup taken (2026-06-08 00:30
  UTC, 1.95 GB); backup schedule enabled, Daily plus Weekly plus Monthly tiers
  (layered retention: 6 days / 1 month / 3 months). Next scheduled backup reported
  pending.
- maglev (wonderful-surprise Postgres, the redundant 2.4M-row scrape): backup
  schedule enabled, Daily. A local validated dump also exists from earlier this
  session (208M custom-format, sha256
  44e44a4eb5a732fd0975b1787546e221d3a0247e649a83e0f8a024f84cb88558, restore-verified;
  that local dump is CC-verified, distinct from the dashboard schedule).
- accurate-ambition Postgres (cross-project DB the WS ACC backend reaches into,
  near-empty): backup schedule enabled, Daily. Previously had no backup of any kind.

### Status
All three Postgres services now have active backup schedules (operator-reported; CC
could not CLI-verify, see verification note). The acute exposure (unprotected
production data) is closed. Note: Railway-native backups live in Railway storage,
which protects against corruption, accidental delete, and bad migration, but NOT
against loss of the Railway account. An off-platform copy of production remains a
lower-priority open item.

### Backpressure candidate (elevate toward a ledger row)
"Every production Postgres must have an active backup schedule." This session found
a production DB with zero backups; the systemic fix is a periodic check asserting
every platform database has a recent backup and a schedule, alerting if not. Among
the strongest ledger candidates from this session, alongside the DB-identity-mapping
lesson. Encode once a mechanism is chosen.

---

## 2026-06-09 - CORRECTION: maglev is NOT a confirmed subset of production; "redundant duplicate" verdict overturned

Step 5 by-key superset gate (read-only; frozen local captures of corporate_number
from both sides; local staging only, dropped after). Result: maglev is NOT a
confirmed subset of ACC production (turntable, sysid 7533606245792546852). The gate
does NOT pass, for three independent reasons:
- KEYED ANTI-JOIN not empty. corporate_number is the only shared key (scraped_smes
  has NO name_hash column, so the planned fallback does not exist). 7,077 maglev
  corporate_numbers are ABSENT from production (subset requires zero). Bidirectional
  divergence: 2,807 production keys are absent from maglev.
- ABOUT 40% UNKEYABLE. maglev 907,029 NULL corporate_number (37.6%); production
  1,074,928 (41.7%). With no name_hash fallback these rows cannot be key-compared,
  so the gate is structurally inconclusive for them.
- FRESHNESS INVERSION. maglev scraped_smes max enrichment_date 2026-06-05 is NEWER
  than production's 2026-05-19. maglev is not a stale trailing copy; its enrichment
  is more recent.

Row counts (CC-measured 2026-06-09): maglev scraped_smes 2,413,950 (1,506,783
distinct corpnum, 907,029 null); production 2,579,637 (1,502,513 distinct,
1,074,928 null). Enrichment is sparse on both (phone ~100% null, full_address
~87% null).

Verdict: the earlier "redundant, trailing duplicate" framing (based on row count
alone: prod 2.58M > maglev 2.41M) is OVERTURNED. Row count does not establish
containment, and enrichment recency runs the other way. maglev holds at least 7,077
keyed SMEs production lacks, a roughly 907K unkeyable fraction, and fresher
enrichment - it has independent value.

Decommission: remains CANCELLED and is now CONTRAINDICATED. The gate did not pass,
so retiring maglev or the WS scraper is not authorized; a real reconciliation would
first need a stable shared key (name_hash does not exist) and a plan for the ~907K
null-key rows. All read-only; no changes; surface, don't repair.

Related: BP-001 in BACKPRESSURE_LEDGER.md gained a 2026-06-09 DATA RESULT (bounces
ARE written into outreach_unsubscribes on ACC/LAW/INV; protective for deliverability
but conflates suppression metrics; my prior re-spec corrected).

---

## 2026-06-09 - KNOWN ISSUE: canadaaccountants.app profile pages soft-404 / not-indexed

SEVERITY: growth issue (pages not indexed), NOT data-loss. Lower priority than the
pending fleet backup. Read-only diagnostic; no code/sitemap/DB change, no deploy.

SYMPTOM (Google Search Console): 387 soft-404 (sample), 2,301 crawled-not-indexed,
4,689 discovered-not-indexed on /profile?id=N pages.

ROOT CAUSE (two compounding, structural; NOT a data-quality problem):
1. Stale served sitemap. The served sitemap-profiles-1/2.xml is a raw id-range dump
   (id 14671..27470, about 12,800 URLs) that was never regenerated from the current
   generator. Of that served pool: 96% have no email, 95% no firm name, about 0.8%
   (103) would qualify as indexable. The generator itself is fine
   (/api/sitemap-profiles.xml filters to email present + status<>'invalid' -> 7,427
   well-populated profiles, thin about 0%). So Google is being fed about 12,700
   non-qualifying URLs from the stale static files, not from the live generator.
2. Static-200 SPA. /profile?id=N is a Firebase-served static page that always
   returns HTTP 200 and fetches the real record client-side. The API returns the
   correct status (404 missing / 410 gated / 200 valid), but it never reaches Google
   as an HTTP status, so missing and gated profiles render as soft-404s. Confirmed
   live: /profile?id=28181 returns page 200 while /api/profiles/28181 returns 410.
   The six sampled soft-404 ids were well-populated (firm/city/name/designation
   present) but all had has_enrichment_collision=true -> API 410, page 200: gated,
   not thin.

PROPOSED FIX (NOT implemented; for a future reviewed change, deploy gated):
A. Propagate real HTTP status via a Cloud Function / SSR in front of /profile: 404
   if id absent, 410 if gated (is_misclassified OR has_enrichment_collision OR
   is_generic_inbox), noindex-200 if below the content threshold, 200 if indexable.
B. Content-threshold gate as specced: indexable = exists AND not gated AND has email
   AND status<>'invalid' AND firm_name AND city present (plus bio or designation).
   Do NOT require phone (100% null across the pool would noindex everything).
C. Regenerate the served sitemap from the generator and add a regeneration step so
   it cannot drift stale again; also tighten the generator filter to the content
   threshold (currently email + status only, which lets about 1,117 gated records
   through).
D. Audit internal directory / find-cpa links to omit or nofollow below-threshold or
   gated profiles. Google soft-404'd ids that are NOT in the sitemap (e.g. 28181,
   37195), so it is discovering profile URLs via internal links; a sitemap-only fix
   leaves that bleed.

SEQUENCING: ship A+B+C together; C alone leaves the soft-404 bleed via internal
links (D). The content threshold must be set carefully to avoid deindexing the
7,427 already-good profiles.

Measurements (CC-measured 2026-06-09, read-only): scraped_cpas total 100,060;
generator-qualifying pool 7,427 (thin about 0%, 1,117 gated); served-sitemap id
range 14671..27470 = 12,800 rows (no_email 12,281, no_firm 12,175, status invalid
232, gated 214, would-qualify 103). All read-only; surface, don't repair.

---

## 2026-07-01 - Referral rail: NETWORK_SHARED_SECRET rotation runbook

The cross-platform referral rail (Build Spec v1.2) authenticates server-to-server
traffic between ACC, LAW, INV, and CBE with ONE shared HMAC secret,
`NETWORK_SHARED_SECRET` (64 hex chars, identical on all four Railway services).
One compromise exposes the whole rail; rotate on any suspicion of exposure, same
policy as `RESEND_WEBHOOK_SECRET`.

The receiver verifies against BOTH `NETWORK_SHARED_SECRET` and
`NETWORK_SHARED_SECRET_NEXT` (modules/referrals/hmac.js), so rotation is staged
and zero-downtime. Senders always sign with the primary only.

Rotation procedure (four services: canadaaccountants-backend, canadalawyers
backend, canadainvesting-backend, CBE backend - resolve each service name
explicitly per the Railway deploy discipline; NEVER touch a postgres service):

1. Generate the new secret locally: `openssl rand -hex 32`. Do not paste it into
   any chat, log, or commit.
2. Set `NETWORK_SHARED_SECRET_NEXT=<new>` on ALL FOUR services. Wait for each
   service to restart and verify health. Receivers now accept old OR new;
   senders still sign with old. Nothing breaks at any point in this window.
3. Flip the primary: set `NETWORK_SHARED_SECRET=<new>` on ALL FOUR services.
   Senders now sign with new; any not-yet-restarted receiver still accepts it
   via `_NEXT`. Verify a signed round-trip (the referral-rail self-test or a
   signed GET /api/network/health peer-to-peer).
4. Remove `NETWORK_SHARED_SECRET_NEXT` from all four services once every
   service is confirmed running the new primary.
5. Log the rotation here (date, reason, operator). Old secret is dead; anything
   still signing with it gets 401s, which is the desired loud failure.

Order within each step does not matter; order BETWEEN steps does. Never set the
new value as primary anywhere before step 2 has covered all four services.
