# Hand-off addendum, 5 October 2026 (session b)

Working note, not repository documentation. Delete before any PR from this branch merges.
Builds on `NEXT-SESSION-2026-10-05.md` (branch `claude/hopeful-johnson-qdl66o`) and
`HANDOFF-2026-09-30.md` (branch `claude/adoring-ritchie-uhm8v7`). No personal data here: this repo is public.

## Step 0 result

GitHub OK (5 repos attached; canadalawyers frontend read-only, needs `add_repo` with push for A4).
Railway API OK. Postgres proxies: all four time out. DNS now resolves, but the session proxy answers
`200 Connection Established` for any host:port (also `example.com:5432`) and nothing returns on non-443
ports. Diagnosis: the sandbox does not relay raw TCP on non-443 ports; the allow-list is not the issue.
Fallback in use: read-only psql files run by Arthur locally (kept out of git; they name requesters).

## Done this session (no production writes, no merges, no emails)

- A2: LAW PR #34 still open. Re-verified against main 26b308a: merge clean, 94/84/0/10 (main 91/81/0/10).
- A15: snapcost PR #16 still open. Merge clean, 43/43 (main 40/40; tests need `npm install` first).
  Live build is still 8ae908ed (23 Sep). Autodeploys from main.
- A5: Railway log retention is ~30 days (oldest INV line 5 Sep 22:45 UTC), so the 27 Aug webhook log is
  gone. Code reading: the `customer.subscription.deleted` UPDATE keys on `stripe_subscription_id`, never
  checks rowCount and always returns 200, so a row with NULL or a different sub id is skipped silently.
  Also `subscription.updated` writes raw Stripe statuses into a CHECK-constrained column.
  Query I1 distinguishes "silent no-op" from "never delivered".
- A1 live status via the public LAW API: A1.1 and A1.3 profiles still 200; A1.2 profile 410
  dispute_pending (hidden, not removed, D-8 still open). A1.1 has an identity mismatch between the
  requester and the profile name: Arthur to decide before any write.

## Baselines

LAW main 91/81/0/10 (was 84) · LAW main + A2 94/84/0/10 · snapcost main 40/40, + A15 43/43.

## Next

Arthur runs the read-only files and pastes the output; then the write order in the run guide, each
write confirmed individually. `dburls.json` deleted (unusable from this sandbox).
