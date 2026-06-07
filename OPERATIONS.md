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
