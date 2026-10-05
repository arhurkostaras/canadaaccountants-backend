# Supply sequence templates

`supply_v3_3touch.json` holds the three-touch supply sequence for all four
platforms (rows tagged `acc`, `law`, `inv`, `cbe`). Each backend's
`scripts/load-templates.js` loads only its own platform's rows and skips the
rest, so the same file can be loaded from every backend:

    DATABASE_URL=... node scripts/load-templates.js --dry-run /path/to/supply_v3_3touch.json

| Touch | Day | Theme | Subject B (founding ratio ≥ 40%) |
|---|---|---|---|
| 1 | 0 | Purpose: what clients in your area need | none |
| 2 | 7 | Identity: what you want to be known for | none |
| 3 | 21 | Belonging: founding membership, then stop | `{{founding_remaining}}` places left |

`tests/supply-v3-templates.test.js` checks every merge tag against the tags
each backend's strict-mode renderer resolves, bans the retired pitch lines and
hard-coded figures, and renders the ACC rows through the real render engine.

## Not live

Loading these rows sends nothing. Before any touch can go out:

1. `services/sequence-runner-v2.js` on each backend is hard-coded to
   `supply_v2_7touch` (CBE: `supply_v2_6touch`) with a 7-step schedule. It
   needs the sequence name and a 3-step schedule (days 0, 7, 21) for
   `supply_v3_3touch`. Loading v3 rows under the v2 name would leave touches
   4–7 without templates.
2. The runner is not wired to cron and refuses to send unless
   `V2_RUNNER_LAUNCH_READY=true`.
3. ACC sits under the 2026-06-10 professional-contact moratorium. Lifting it
   requires Arthur's written decision.
4. Calls to action point to each platform's find page (`/find-cpa`,
   `/find-lawyer`, `/find-advisor`), because the v2 runner stores no
   per-recipient claim token, so `/api/c/:id` would fall back to the same page.
   CBE has no claim flow, so its touches ask for a reply. A `{{claim_url}}`
   tag for one-click claims would be a separate change on each backend.
5. Touch 3 promises founding members input before changes that affect their
   practice. Keep that promise, or edit the line, before sending.
