# Runbook - Decommission the wonderful-surprise project

> **BLOCKED: DO NOT EXECUTE STAGES 3/5/6/7 (added 2026-06-28).**
> This runbook is stale relative to the 2026-06-09 OPERATIONS correction. Service
> `a2164d8c` is `maglev` (the 2.4M-row scrape), NOT the `switchback` DB this runbook
> pairs it with. Per OPERATIONS.md (2026-06-09), retiring maglev or the WS scraper is
> CONTRAINDICATED (maglev holds about 7,077 keyed SMEs production lacks, about 907K
> unkeyable rows, and fresher enrichment). Therefore Stage 6 (delete `a2164d8c`) and
> Stage 7 (delete the project, which contains it) would destroy contraindicated data,
> and the TARGET LOCK below will NOT stop it: the flaw is in scope, not targeting. Note
> too that Stage 1's backup host note (`switchback:20584`) points at a different DB than
> Stage 6 deletes. Only safe action: remove the WS ACC backend service `da3bd205`
> (the service only, never the project). Unblock Stages 5-7 only after OPERATIONS records
> a real maglev-to-production reconciliation: a stable shared key (`name_hash` does not
> exist), plus a plan for the roughly 907K null-key rows.

Status: PLAN ONLY. Not executed. Every destructive stage is always-ask and gated
individually. The decommission OUTCOME is recorded in OPERATIONS.md when executed;
this file is the procedure and stays as-is.

## Canonical identifiers (act by ID + domain, never by service name)

IN SCOPE - wonderful-surprise (everything below):

| Item | ID / domain |
|---|---|
| Project | wonderful-surprise = fb4795a2-62d7-4817-96fd-9272dabe0a18 |
| App svc 1 | canadaaccountants-backend = da3bd205-8c7b-4edf-8894-e3787aa6a227 - domain canadaaccountants-backend-production.up.railway.app (plain, no -1d8f) |
| App svc 2 | sme-intelligence-backend = 2832c048-77b5-4c6c-b265-a85443301777 - domain sme-intelligence-backend-production.up.railway.app (plain, no -5185) - currently 502 |
| Data svc 1 | Postgres = a2164d8c-4365-4cf9-bfea-2da28fe7fdbc (both WS apps connect here) |
| Data svc 2 | Redis = 4c059c9c-6caf-4276-89d0-07e2a4e9fcd7 |

NEVER TOUCH - different project(s):

| Item | ID / domain | Why |
|---|---|---|
| Project fulfilling-empathy | 9681a493-d648-4d63-87ab-b9fd362947b3 | production ACC |
| FE ACC canadaaccountants-backend | 2b8afbfa-acf5-4fa2-b531-67b1032767d0 - ...-production-1d8f... | live production |
| Shared SME -5185 | sme-intelligence-backend-production-5185.up.railway.app (in fulfilling-empathy) | consumed by INV + LAW + Stripe |
| FE Postgres / Redis | (in fulfilling-empathy) | production data |

Same-name trap: both projects contain services literally named
canadaaccountants-backend and sme-intelligence-backend. Never act by service name.
The plain -production SME domain is WS (dead); the -5185 SME domain is the shared
production one in a different project.

## TARGET LOCK (mandatory pre-action gate for every destructive step)

Before any stop/delete, confirm all three, and abort on any mismatch:
1. Project: railway status shows Project: wonderful-surprise / id
   fb4795a2-62d7-4817-96fd-9272dabe0a18.
2. Service ID: the target serviceId equals the WS id in the table above (read from
   railway status --json), and is NOT 2b8afbfa (FE ACC) and NOT the -5185
   serviceId recorded in Stage 0.
3. Domain (for app services): railway domain returns the plain -production WS
   domain, NOT ...-1d8f... and NOT ...-5185...
Assert also: target project id is not 9681a493 (fulfilling-empathy). If any check
fails, STOP and re-verify.

---

## Stage 0 - Pre-flight identity lock (read-only)
- Action: record/confirm all IDs above; additionally look up and record the -5185
  service's serviceId and its project so later assertions can name it concretely.
  Confirm -5185 is in fulfilling-empathy (not wonderful-surprise) and that no WS
  serviceId equals it.
- Verify: the four WS service IDs resolve under project fb4795a2; -5185 resolves
  under 9681a493.
- Reversible: N/A (read-only). Gate: none (read-only), but this stage's output is
  the precondition for every later gate.

## Stage 1 - Backup the live WS Postgres FIRST, before any change (non-destructive)
Runs before Stage 2/3 stop anything, against the live, running, untouched DB,
which is the most predictable state to dump.
- Action: snapshot the WS Postgres (a2164d8c). There is one WS Postgres service
  that both WS apps use (ACC via the TCP proxy switchback.proxy.rlwy.net:20584,
  SME via internal), so:
  1. Enumerate logical databases first (psql ... -c "\l"). Do not assume one;
     capture however many exist (ACC and SME may share railway or be separate).
  2. pg_dump each database (or pg_dumpall) using the WS Postgres credentials
     (read from the WS Postgres service variables; used in-process, never echoed).
  3. Write dumps outside all repos and outside phronisi, e.g.
     ~/cc-backups/<date>/wonderful-surprise-postgres/<db>.sql. Record file names,
     sizes, and sha256 of each dump.
  4. Validate the dump (not just that it ran): test-restore into a throwaway local
     Postgres and confirm row counts / no errors. A dump you have not restored is
     not a backup.
  - Redis (4c059c9c): cache, and WS SME could not even connect to it; assume no
    canonical data. Verify there is no RDB/AOF persisting anything unique; if there
    is, snapshot it too. Otherwise record "cache only, no backup needed" with the
    reason.
- Contingency: if backup ever has to run after services are stopped instead of
  here, first verify the WS Postgres (a2164d8c) is independently reachable
  (psql connect + \l) before relying on it. Stopping the app services should not
  affect the Postgres service, but confirm rather than assume.
- Pre-action verify: confirm the connection host/credentials belong to the WS
  Postgres (a2164d8c, host switchback.proxy.rlwy.net:20584), not FE's Postgres.
- Reversible: additive (no deletion). Rollback: N/A.
- Gate: yes (credentialed DB read). This step can be executed from the CLI
  (foreground pg_dump, no secret echo). Do not proceed past here until the dump is
  validated-good; it is the safety net for Stages 5 and 6.

## Stage 2 - Disable autodeploy on both WS app services (reversible)
- Action (dashboard, operator): WS canadaaccountants-backend - confirm "Auto
  deploys" is already off (done in Option A). WS sme-intelligence-backend
  (2832c048) - set "Auto deploys when pushed to GitHub" to off so a push to
  arhurkostaras/sme-intelligence-backend no longer rebuilds the WS duplicate.
- Pre-action verify: TARGET LOCK on 2832c048 (project fb4795a2, plain -production
  SME domain, NOT -5185).
- Reversible: yes - re-enable the toggle. Rollback: flip "Auto deploys" back on.
- Gate: yes (infra config). Browser action; performed by the operator and verified
  after. Functional proof (an SME-repo push builds neither WS) is deferred to the
  next genuine SME push; no throwaway commit.

## Stage 3 - Stop the running WS services (reversible)
- Action: stop the running deployments for WS canadaaccountants-backend (da3bd205)
  and WS sme-intelligence-backend (2832c048) - railway down on each (removes the
  active deployment / stops the container). Halts the WS ACC scheduler ticks and
  the WS SME Redis-timeout loop.
- Pre-action verify: TARGET LOCK on each serviceId before each down. Run railway
  status and confirm Project: wonderful-surprise every time.
- Reversible: yes - the service, config, env, and volumes remain; redeploy to
  restore. Rollback: railway redeploy --service <id> (or re-up).
- Gate: yes (stops a running service). Safe because nothing depends on either
  (zero consumers; SME already 502).
- Order: ACC first, then SME (independent; order not critical).

## Stage 4 - Observation window (no action; safety gate)
- Action: with both WS app services stopped, hold for a defined window
  (recommend 48-72h) and confirm nothing elsewhere breaks:
  - Production ACC (...-1d8f...) /health 200; claims/sends/pipeline normal.
  - Shared SME -5185 root operational; INV / LAW / Stripe consumers of -5185
    unaffected (they never used WS).
  - No new errors anywhere referencing the WS plain -production domains.
- Why 48-72h is the right size: this window is sized to catch real-time breakage
  (a live caller that errors immediately when WS stops responding). It is
  sufficient BECAUSE Stage 0 confirmed the WS ACC scheduler was already
  non-functional (it errored on every tick - relation "crm_sequence_enrollments"
  does not exist - and WS has no Resend identity), and the WS SME was already 502
  with no consumers. The window is NOT a claim that longer-cadence effects (for
  example a monthly job) were independently ruled out; there is nothing to rule
  out because the schedulers were already dead in Stage 0. If Stage 0 had shown a
  working scheduler, this window would need to be longer or the analysis redone.
- Reversible: N/A (no action). Gate: this is a hold - resuming to Stage 5 needs
  explicit go. Nothing irreversible has happened yet; if anything looks off,
  Stage 3 rollback (redeploy) fully restores WS.

## Stage 5 - Delete the WS app services (irreversible; re-creatable from repo)
- Action (dashboard or GraphQL serviceDelete, operator): delete WS
  canadaaccountants-backend (da3bd205) and WS sme-intelligence-backend (2832c048).
- Pre-action verify: TARGET LOCK on each serviceId immediately before deletion -
  project fb4795a2, the WS serviceId, and the plain -production domain. Explicitly
  re-assert serviceId is not 2b8afbfa and not the -5185 serviceId.
- Reversible: irreversible as a service object, but re-creatable from
  arhurkostaras/canadaaccountants-backend / arhurkostaras/sme-intelligence-backend
  (source still in GitHub). Rollback: re-create the service from the repo and
  re-enter env (these were inert; minimal env).
- Gate: yes, always-ask. First irreversible-in-practice stage. Browser/GraphQL
  action; operator performs, with IDs + verification supplied.

## Stage 6 - Delete the WS data services (irreversible data loss; backed up in Stage 1)
- Action (dashboard/GraphQL, operator): delete WS Postgres (a2164d8c) and WS Redis
  (4c059c9c).
- Pre-action verify: TARGET LOCK by project + serviceId (Postgres/Redis have no
  public app domain). Confirm project fb4795a2 and the exact serviceIds; confirm
  these are not FE's data services. Confirm the Stage 1 dump exists and was
  validated (sha256 on record).
- Reversible: irreversible (data deleted). Rollback: re-provision Postgres and
  pg_restore from the Stage 1 dump; re-provision Redis (cache, nothing to restore).
- Gate: yes, always-ask, with explicit confirmation that the validated backup
  exists before proceeding.

## Stage 7 - Delete the project shell (final, irreversible)
- Action (dashboard/GraphQL, operator): delete the now-empty wonderful-surprise
  project (fb4795a2).
- Pre-action verify: confirm the project id is fb4795a2 and that it contains no
  remaining services (all deleted in 5-6); assert id is not 9681a493
  (fulfilling-empathy).
- Reversible: irreversible. Rollback: none (re-create a new project + services from
  repos + restore the dump if ever needed).
- Gate: yes, always-ask. Only at the very end.

## Stage 8 - Post-decommission verification (read-only)
- Verify:
  - WS plain -production domains (ACC + SME) now resolve to nothing / 404 (gone).
  - Production ACC ...-1d8f... /health 200; shared SME -5185 operational; INV /
    LAW / Stripe unaffected.
  - A push to either shared repo builds only the fulfilling-empathy services (no
    WS targets remain).
- Reversible: N/A. Gate: none (read-only). Record the outcome in OPERATIONS.md
  (the open "full WS decommission" item closes there).

---

## Re-confirm at execution
The shared SME -5185 lives in fulfilling-empathy (9681a493), a different project
from wonderful-surprise (fb4795a2). Retiring wonderful-surprise's SME service
(2832c048, plain -production) therefore cannot affect -5185. The runbook still
re-confirms this at execution via the TARGET LOCK on every destructive step
(project id + serviceId + domain), never by service name.

## Execution split (who does what)
- Can be executed from the CLI: Stage 0 (read-only checks), Stage 1 backup
  (foreground pg_dump, no secret echo), Stage 4 verification reads, Stage 8
  verification. Stage 3 railway down can be run from the CLI with TARGET LOCK if
  authorized.
- Operator (browser) must perform: Stages 2, 5, 6, 7 are Railway dashboard actions;
  the IDs and TARGET-LOCK checks are supplied and verified after each.
- Every destructive stage is always-ask, gated individually, in order, with the
  live-DB backup first and project deletion last.
