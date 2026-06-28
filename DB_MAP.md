# Personal Platforms DB Map

Incident-response quick reference for the personal-platforms Postgres topology on
Railway. Built 2026-06-09 by a read-only sweep of the live project list, reconciled
against the OPERATIONS.md correction entry. Fleet-wide (like BACKPRESSURE_LEDGER.md),
homed in the ACC backend repo.

ISOLATION: the Phronisi projects (phronisi-fma-channel, phronisi-demand-engine) are
deliberately EXCLUDED per the workspace boundary. They are not on this map.

CONFIDENCE LEVELS (read every row with its level):
- CONFIRMED: identity verified by connecting and reading `pg_control_system()`
  `system_identifier`.
- FINGERPRINT: identified by Railway public-proxy `host:port` plus a sha256
  fingerprint of the connection password (no secret stored). Same fingerprint =
  same credential = same instance. NOT connect-verified.
- FLAGGED: an ambiguity that must NOT be resolved by assumption; see Flags.

Rule (BACKPRESSURE candidate #13): map infrastructure by DB identity
(`system_identifier`) and env fingerprint, never by code grep or project name.

## Confirmed production instances (6 distinct; Step 1 connects 2026-06-07/09)

| system_identifier | instance (public proxy) | PG | role / creds |
|---|---|---|---|
| 7533606245792546852 | fulfilling-empathy / turntable:13986 | 16.12 | ACC production (app schema + 2,579,637-row served scrape); creds 28d41e (backend) + dd9a08 (SME -5185) |
| 7609747580081692708 | canadainvesting-backend / yamanote:44620 | 17.9 | INV production; creds 6e3753 (backend) + 5f5830 (service) |
| 7632686701601210404 | kind-transformation / nozomi:11628 | 18.3 | CBE production; creds bcdd82 (backend) + 6272d0 (service) |
| 7609455079214186532 | lawyer-intelligence-backend / shinkansen:35443 | 17.7 | LAW production, SHARED with LIB; creds 701f07 (LAW) + 7a87fb (LIB) |
| 7533302060726231076 | wonderful-surprise / maglev:38500 | 16.8 | WS scrape duplicate (2,413,950); trailing copy |
| 7529571790925643812 | accurate-ambition / switchback:20584 | n/r | WS-ACC near-empty (cross-project) |

Not in the 6: `hopper:55031` (d04ff6d1) ORPHAN CANDIDATE, sysid UNREAD; `ballast:32675` (bdc0ed) grantradar, sysid UNREAD.

## Postgres instances (8 projects swept; 9 distinct credentials seen)

| Proxy host:port | pwfp | system_identifier | Project (id) | Holds / serves | Backup | Conf / flags |
|---|---|---|---|---|---|---|
| turntable.proxy.rlwy.net:13986 | dd9a08 | 7533606245792546852 (CONFIRMED 2026-06-09 via 28d41e) | fulfilling-empathy (9681a493) | ACC PROD: app schema (users, stripe_transactions, outreach_*) AND the 2,579,637-row served scrape (scraped_smes); read by the live -5185 API (INV/LAW/LIB consume that API) | Daily+Weekly+Monthly (operator-reported 2026-06-08; CC could not CLI-verify) | CONFIRMED. Flag A RESOLVED: 28d41e and dd9a08 are two credentials on THIS one instance, not two DBs. |
| (ACC backend cred; same instance as turntable) | 28d41e | 7533606245792546852 (CONFIRMED 2026-06-09) | fulfilling-empathy (9681a493) | same instance as the turntable row; the ACC backend authenticates with role/pw 28d41e | (same instance) | RESOLVED: NOT a separate DB. Two creds on one instance (hardcoded-literal pattern, ref BP-004). |
| maglev.proxy.rlwy.net:38500 | 8b5896 | 7533302060726231076 | wonderful-surprise (fb4795a2), svc a2164d8c, PG 16.8 | 2.4M-row scrape (scraped_smes 2,413,950; scraped_cpas 96,119; market_data; scrape_jobs); written daily | Daily (operator-reported); Fresh validated backup 2026-06-28 (railway.dump 218,071,470 bytes, sha256 2245236f...; restore-verified). Off-site encrypted copy in R2 personal-platforms-db-backups (railway.dump.age, sha256 05ce0dc7...). Supersedes 06-07 dump. See OPERATIONS 2026-06-28. | CONFIRMED. Redundant/trailing duplicate of demand data; read only by the WS scraper. NOTE: overturned 2026-06-09, retirement CONTRAINDICATED; see OPERATIONS. |
| switchback.proxy.rlwy.net:20584 | f2dfe9 | 7529571790925643812 | accurate-ambition (85fc2f19), svc c435b148 | near-empty ACC schema (~2 users, test data) | Daily (operator-reported); NOT yet dumped by CC | CONFIRMED. See Flag D (lone Postgres-only project, cross-project consumer). |
| hopper.proxy.rlwy.net:55031 | d04ff6d1 | UNREAD (not connected) | canadalawyers-backend (8154cf1a) | UNKNOWN; the LAW backend does NOT use it (LAW prod lives in shinkansen, see Flag E) | UNKNOWN | ORPHAN CANDIDATE: nominal LAW project Postgres, unused by the LAW backend. sysid UNREAD, status unknown. DO NOT TOUCH pending investigation; do not assume safe to remove. |
| shinkansen.proxy.rlwy.net:35443 | 7a87fb (LIB) / 701f07 (LAW) | 7609455079214186532 (CONFIRMED 2026-06-09 via 701f07) | lawyer-intelligence-backend (27388c17) | LAW PROD (outreach_emails 20,574; outreach_unsubscribes 1,287; scraped_smes 9,039) AND LIB data; SHARED by both backends (two creds, one instance) | UNKNOWN | CONFIRMED. Flag E: canadalawyers PROD DATA lives HERE, in the lawyer-intelligence-backend project, NOT in the canadalawyers project. |
| yamanote.proxy.rlwy.net:44620 | 5f5830 (service) / 6e3753 (backend) | 7609747580081692708 (CONFIRMED 2026-06-09 via 6e3753) | canadainvesting-backend (715d4716) | INV PROD (users 12; outreach_recipients 71,106; outreach_unsubscribes 1,370; scraped_advisors 55,805; scraped_smes 18,288) | UNKNOWN | CONFIRMED. Flag B RESOLVED: 6e3753 and 5f5830 are two creds on this one instance, not two DBs (hardcoded-literal, ref BP-004). |
| ballast.proxy.rlwy.net:32675 | bdc0ed | UNREAD (not connected) | grantradar (7c913792) | grantradar data | UNKNOWN | FINGERPRINT, CONSISTENT (backend fp == service fp). |
| nozomi.proxy.rlwy.net:11628 | 6272d0 (service) / bcdd82 (backend) | 7632686701601210404 (CONFIRMED 2026-06-09 via bcdd82) | kind-transformation (b39c1fc4) | CBE PROD (bankers 652; smes 7; outreach_emails 434; unsubscribes 11; bounces 6) | UNKNOWN | CONFIRMED. MISNAMED project (hosts CBE). Flag C RESOLVED: bcdd82 and 6272d0 are two creds on this one instance, not two DBs (hardcoded-literal, ref BP-004). |

## App backend -> DB credential (what each backend actually connects to)

| Backend (project) | Connects to | pwfp | Resolution |
|---|---|---|---|
| canadaaccountants-backend (fulfilling-empathy) | postgres.railway.internal | 28d41e | Different cred, SAME instance 7533606 (Flag A RESOLVED) |
| sme-intelligence-backend / -5185 (fulfilling-empathy) | postgres.railway.internal | dd9a08 | Same instance 7533606 (service cred) |
| canadaaccountants-backend (wonderful-surprise) | switchback.proxy.rlwy.net:20584 | f2dfe9 | CROSS-PROJECT to accurate-ambition 7529 (Flag D, confirmed) |
| sme-intelligence-backend (wonderful-surprise) | postgres.railway.internal | 8b5896 | maglev 7533302 (the WS scraper) |
| canadalawyers-backend (canadalawyers-backend) | shinkansen.proxy.rlwy.net:35443 | 701f07 | CROSS-PROJECT to LIB Postgres 7609455 (Flag E); LAW prod lives there, shared with LIB |
| canadainvesting-backend (canadainvesting-backend) | postgres.railway.internal | 6e3753 | Different cred, SAME instance 7609747 (Flag B RESOLVED) |
| lawyer-intelligence-backend (lawyer-intelligence-backend) | postgres.railway.internal | 7a87fb | shinkansen 7609455 (own; shared with LAW) |
| grantradar-backend (grantradar) | postgres.railway.internal | bdc0ed | ballast (consistent; sysid UNREAD) |
| canadabusinessexits-backend (kind-transformation) | postgres.railway.internal | bcdd82 | Different cred, SAME instance 7632686 (Flag C RESOLVED) |

## Flags (do NOT classify these silently)

- **SYSTEMIC (Flags A, B, C) RESOLVED 2026-06-09.** ACC, INV, CBE each connect with a credential that does NOT match their project's managed Postgres credential, but read-only connects confirmed each is the SAME instance accessed by TWO credentials (a role/password distinct from the service's managed one), NOT a second database. This is the hardcoded-literal pattern (see BP-004): the backend hardcodes a connection string whose role/password differs from the managed service credential but resolves (via postgres.railway.internal) to the same project instance. The "second hidden DB" possibility is ruled out for ACC/INV/CBE. LAW (Flag E) is the genuine exception (cross-project, see below).
- **Flag A - RESOLVED 2026-06-09.** ACC's production DB is the fulfilling-empathy Postgres instance, system_identifier 7533606245792546852 (PG 16.12), public proxy turntable:13986. The ACC backend (28d41e) and the -5185 SME API (dd9a08) are two credentials on this ONE instance. It holds the ACC app schema (users, stripe_transactions, outreach_*) AND the 2,579,637-row served scrape. dd9a08's role in the plan holds.
- **Flag B - RESOLVED 2026-06-09.** INV's production DB is the canadainvesting-backend project Postgres, system_identifier 7609747580081692708 (PG 17.9), yamanote:44620. 6e3753 (backend) and 5f5830 (service) are two creds on one instance.
- **Flag C - RESOLVED 2026-06-09 (project still MISNAMED).** The project named `kind-transformation` hosts the CanadaBusinessExits backend (CBE). CBE's production DB is that project's Postgres, system_identifier 7632686701601210404 (PG 18.3), nozomi:11628. bcdd82 (backend) and 6272d0 (service) are two creds on one instance. The misnaming stands as an incident-response trap.
- **Flag D - accurate-ambition is a lone Postgres project, consumed cross-project.** No app services; exists only to host the WS ACC backend's near-empty DB (switchback, CONFIRMED sysid 7529...). Name gives no hint of its role.
- **Flag E - canadalawyers DB is cross-project. INCIDENT-RESPONSE NOTE: the canadalawyers PRODUCTION DB is NOT in the canadalawyers project.** The LAW backend connects (credential 701f07) to `shinkansen:35443`, which is the **lawyer-intelligence-backend project's Postgres**, system_identifier 7609455079214186532 (PG 17.7), CONFIRMED 2026-06-09. LAW's production data lives THERE (outreach_emails 20,574; outreach_unsubscribes 1,287; scraped_smes 9,039), shared with LIB (LIB uses 7a87fb, LAW uses 701f07: two creds, one instance). LAW's own nominal project Postgres, `hopper:55031` (d04ff6d1), is UNUSED by the LAW backend - an ORPHAN CANDIDATE: sysid UNREAD (not connected), status unknown. DO NOT TOUCH pending investigation; do not assume it is safe to remove.
- **Misnamed-project summary (incident-response trap):** `kind-transformation` = CBE; `accurate-ambition` = WS-ACC's DB; `wonderful-surprise` = the ACC duplicate + the maglev scraper; `fulfilling-empathy` = the real ACC production project; LAW production lives in `lawyer-intelligence-backend`. Random Railway names give no platform hint; always resolve by id + fingerprint.

## Confirmed vs gated
- CONFIRMED by connect (system_identifier), 2026-06-07/09: ACC-prod 7533606245792546852 (turntable), INV 7609747580081692708 (yamanote), CBE 7632686701601210404 (nozomi), LAW 7609455079214186532 (shinkansen, shared with LIB), maglev 7533302060726231076 (WS), switchback 7529571790925643812 (accurate-ambition).
- Still FINGERPRINT-only (not connected): `hopper` (d04ff6d1, ORPHAN CANDIDATE) and `ballast` (bdc0ed, grantradar).
- Backup status is operator-reported for dd9a08 / maglev / accurate-ambition and UNKNOWN for the other instances. Given the zero-backup root cause (Railway does not auto-backup), the UNKNOWN ones (notably the confirmed INV/CBE/LAW production instances) are likely also unbacked; confirm at Phase 1.0.

## Action note for Phase 1 fleet backup
Back up the DB each backend ACTUALLY connects to, now confirmed by sysid (ACC
turntable, INV yamanote, CBE nozomi, LAW shinkansen), not the nominal project
Postgres - because for ACC/INV/CBE the backend uses a different credential on the
same instance, and for LAW production lives cross-project in the LIB instance.
Personal-platform projects ONLY; Phronisi excluded. `hopper` stays do-not-touch
pending investigation.

## Provenance
Built 2026-06-09 from a read-only `railway` sweep (project list, per-service
DATABASE_URL / DATABASE_PUBLIC_URL host:port + password sha256 fingerprint; no
secret values stored). Supersedes, for quick-reference purposes, the topology
narrative embedded in the OPERATIONS.md correction entry. system_identifier values
were read by read-only connect: maglev and switchback during 2026-06-07; ACC, INV,
CBE, and LAW during the 2026-06-09 Step 1 identity checks (ACC/INV/CBE reached by
substituting the project Postgres public proxy for the backend's internal host
while keeping the backend credential; LAW reached directly, its DATABASE_URL host
is already public). Surface, don't repair: the four credential mismatches and the
hopper orphan are mapped, not changed.
