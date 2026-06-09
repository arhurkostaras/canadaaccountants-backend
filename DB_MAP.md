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

## Postgres instances (8 projects swept; 9 distinct credentials seen)

| Proxy host:port | pwfp | system_identifier | Project (id) | Holds / serves | Backup | Conf / flags |
|---|---|---|---|---|---|---|
| turntable.proxy.rlwy.net:13986 | dd9a08 | UNKNOWN (auth failed) | fulfilling-empathy (9681a493) | SME serving DB read by the live -5185 API (consumed by INV/LAW/LIB); operator reports it also holds the app schema (users, stripe_transactions, matches) | Daily+Weekly+Monthly (operator-reported 2026-06-08; CC could not CLI-verify) | FINGERPRINT. See Flag A. |
| postgres.railway.internal (ACC backend's actual DB) | 28d41e | UNKNOWN | fulfilling-empathy (9681a493) | ACC PRODUCTION app data (presumed; unconfirmed) | UNKNOWN | FLAGGED A. |
| maglev.proxy.rlwy.net:38500 | 8b5896 | 7533302060726231076 | wonderful-surprise (fb4795a2), svc a2164d8c, PG 16.8 | 2.4M-row scrape (scraped_smes 2,413,950; scraped_cpas 96,119; market_data; scrape_jobs); written daily | Daily (operator-reported); validated local dump 208M sha256 44e44a4e... | CONFIRMED. Redundant/trailing duplicate of demand data; read only by the WS scraper. |
| switchback.proxy.rlwy.net:20584 | f2dfe9 | 7529571790925643812 | accurate-ambition (85fc2f19), svc c435b148 | near-empty ACC schema (~2 users, test data) | Daily (operator-reported); NOT yet dumped by CC | CONFIRMED. See Flag D (lone Postgres-only project, cross-project consumer). |
| hopper.proxy.rlwy.net:55031 | d04ff6d1 | UNKNOWN | canadalawyers-backend (8154cf1a) | UNKNOWN; the LAW backend does not use it | UNKNOWN | FINGERPRINT. See Flag E (possible orphan). |
| shinkansen.proxy.rlwy.net:35443 | 7a87fb | UNKNOWN | lawyer-intelligence-backend (27388c17) | LIB data; ALSO reached cross-project by the LAW backend (different credential) | UNKNOWN | FINGERPRINT. See Flag E (shared cross-project). |
| yamanote.proxy.rlwy.net:44620 | 5f5830 | UNKNOWN | canadainvesting-backend (715d4716) | UNKNOWN; the INV backend connects with a different credential | UNKNOWN | FINGERPRINT. See Flag B. |
| ballast.proxy.rlwy.net:32675 | bdc0ed | UNKNOWN | grantradar (7c913792) | grantradar data | UNKNOWN | FINGERPRINT, CONSISTENT (backend fp == service fp). |
| nozomi.proxy.rlwy.net:11628 | 6272d0 | UNKNOWN | kind-transformation (b39c1fc4) | UNKNOWN; the CBE backend connects with a different credential | UNKNOWN | FINGERPRINT. See Flag C (misnamed project). |

## App backend -> DB credential (what each backend actually connects to)

| Backend (project) | Connects to | pwfp | Matches its project Postgres? |
|---|---|---|---|
| canadaaccountants-backend (fulfilling-empathy) | postgres.railway.internal | 28d41e | NO (project Postgres is dd9a08) - Flag A |
| sme-intelligence-backend / -5185 (fulfilling-empathy) | postgres.railway.internal | dd9a08 | YES (the dd9a08 service) |
| canadaaccountants-backend (wonderful-surprise) | switchback.proxy.rlwy.net:20584 | f2dfe9 | CROSS-PROJECT to accurate-ambition - Flag D |
| sme-intelligence-backend (wonderful-surprise) | postgres.railway.internal | 8b5896 | YES (maglev) |
| canadalawyers-backend (canadalawyers-backend) | shinkansen.proxy.rlwy.net:35443 | 701f07 | NO + CROSS-PROJECT to LIB's host; matches neither - Flag E |
| canadainvesting-backend (canadainvesting-backend) | postgres.railway.internal | 6e3753 | NO (project Postgres is 5f5830) - Flag B |
| lawyer-intelligence-backend (lawyer-intelligence-backend) | postgres.railway.internal | 7a87fb | YES |
| grantradar-backend (grantradar) | postgres.railway.internal | bdc0ed | YES |
| canadabusinessexits-backend (kind-transformation) | postgres.railway.internal | bcdd82 | NO (project Postgres is 6272d0) - Flag C |

## Flags (do NOT classify these silently)

- **SYSTEMIC (Flags A, B, C, E): four backends connect with a credential that does NOT match their project's Postgres service.** FE ACC (28d41e vs dd9a08), INV (6e3753 vs 5f5830), CBE (bcdd82 vs 6272d0) all use the same internal host as their project Postgres but a different password fingerprint; LAW (701f07) connects cross-project and matches nothing. Possible causes (unresolved): a second/hidden Postgres per project, a stale-but-working credential, or a reference-resolution quirk. **Cannot be resolved without connecting (gated, Phase 0.1).** Operational consequence: for these four platforms the DB the backend ACTUALLY uses is NOT confirmed to be the project's visible "Postgres" service, so Phase 1 backup must back up the DB each backend connects to (verified by connecting), not the nominal project Postgres.
- **Flag A - ACC production DB identity unconfirmed.** The production ACC backend (-1d8f, fulfilling-empathy) connects with 28d41e; the project's visible Postgres service is dd9a08 (used by the -5185 SME API). The OPERATIONS.md entry described dd9a08 as "the live serving and operational DB holding users/stripe_transactions" on operator report; this map flags that the ACC backend may use a DIFFERENT instance (28d41e). Resolve by connecting before trusting either.
- **Flag B - INV.** canadainvesting-backend uses 6e3753; INV project Postgres is 5f5830. Same pattern as A. INV's true prod DB unconfirmed.
- **Flag C - kind-transformation is MISNAMED and mismatched.** The project named `kind-transformation` hosts the CanadaBusinessExits backend (CBE). CBE backend uses bcdd82; the project Postgres is 6272d0. Misnamed + credential mismatch.
- **Flag D - accurate-ambition is a lone Postgres project, consumed cross-project.** No app services; exists only to host the WS ACC backend's near-empty DB (switchback, CONFIRMED sysid 7529...). Name gives no hint of its role.
- **Flag E - canadalawyers DB is tangled.** The LAW backend connects to `shinkansen:35443` (the lawyer-intelligence-backend project's Postgres host) with credential 701f07, which matches neither that Postgres service (7a87fb) nor the LAW project's own Postgres (hopper:55031 / d04ff6d1). So: LAW reaches cross-project into LIB's DB host with a third credential, and LAW's own hopper Postgres appears unused (possible orphan).
- **Misnamed-project summary (incident-response trap):** `kind-transformation` = CBE; `accurate-ambition` = WS-ACC's DB; `wonderful-surprise` = the ACC duplicate + the maglev scraper; `fulfilling-empathy` = the real ACC production project. Random Railway names give no platform hint; always resolve by id + fingerprint.

## Confirmed vs gated
- CONFIRMED by connect (system_identifier): maglev (7533..., WS), switchback (7529..., accurate-ambition). Everything else is FINGERPRINT-level (host:port + password fp), not connect-verified.
- All `system_identifier=UNKNOWN` rows, all credential-mismatch flags, and all backup-status entries marked UNKNOWN can only be closed with production DB access (Phase 0.1).
- Backup status is operator-reported for dd9a08 / maglev / accurate-ambition and UNKNOWN for the other five Postgres instances. Given the zero-backup root cause (Railway does not auto-backup), the UNKNOWN five are likely also unbacked; confirm at Phase 1.0.

## Action note for Phase 1 fleet backup
Enumerate and back up the DB each backend ACTUALLY connects to, resolved by
connecting (Phase 0.1), not the project's nominal Postgres service - because for
FE ACC, INV, CBE, and LAW those differ. Personal-platform projects ONLY; Phronisi
excluded.

## Provenance
Built 2026-06-09 from a read-only `railway` sweep (project list, per-service
DATABASE_URL / DATABASE_PUBLIC_URL host:port + password sha256 fingerprint; no
secret values stored). Supersedes, for quick-reference purposes, the topology
narrative embedded in the OPERATIONS.md correction entry. system_identifier values
for maglev and switchback were read by connecting during the 2026-06-07/09
investigation.
