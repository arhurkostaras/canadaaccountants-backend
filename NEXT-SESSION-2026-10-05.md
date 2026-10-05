# Next-session instructions, 5 October 2026

Working note, not repository documentation. Source of truth for history: `HANDOFF-2026-09-30.md`
on branch `claude/adoring-ritchie-uhm8v7` (read it in full first: `git fetch origin
claude/adoring-ritchie-uhm8v7 && git show origin/claude/adoring-ritchie-uhm8v7:HANDOFF-2026-09-30.md`).
This note puts the remaining work in order and adds the database preflight.

## Ground rules (unchanged from the hand-off)

- No PR merges. Merging is Arthur's click.
- No production write (INSERT/UPDATE/DELETE, admin POST, runbook execution) without Arthur
  confirming that specific write in chat. Read-only SELECTs are fine.
- No emails sent. Gmail drafts only; Arthur sends.
- Never print a database password or a full `DATABASE_URL`. Keep connection strings in a
  `chmod 600` file in the scratchpad and delete it at the end of the session.
- Removal confirmations claim only what `verify` proved.
- Push to this session's designated branch, not to the hand-off branch.

## Step 0: preflight (do this before anything else and report the result in a table)

### 0a. GitHub

Attach the six repos with `add_repo`: `canadaaccountants-backend`, `canadalawyers-backend`,
`canadainvesting-backend`, `canadabusinessexits-backend`, `snapcost`, and the canadalawyers frontend
(owner `arhurkostaras`; use `list_repos` if a name doesn't resolve).

### 0b. Railway API

```
curl -sS https://backboard.railway.com/graphql/v2 -H 'Content-Type: application/json' \
  -d '{"query":"{ projects { edges { node { name } } } }"}'
```

`me` returns "Not Authorized" with this token, which is expected. `projects` must list
the projects.

### 0c. Postgres public proxies (the blocker in the last two sessions)

| Backend | Project id | Environment id | Postgres service id | Public proxy |
|---|---|---|---|---|
| ACC | 9681a493-d648-4d63-87ab-b9fd362947b3 | fddaebc0-f6f1-45ef-a840-b85874921328 | b995d360-9df9-4165-ad46-4065bcc794c5 | turntable.proxy.rlwy.net:13986 |
| LAW | 8154cf1a-658b-4548-9db0-a3493b70affb | a618aef4-cd72-4c23-bb64-63315b6a2589 | dcb41c1c-5332-453e-b2cc-0df8cfe562c8 | hopper.proxy.rlwy.net:55031 |
| INV | 715d4716-d182-4264-9ec5-6fcd021aaaab | fd50af09-2be6-4eb2-a9fc-23902394495e | 1b1e5e3a-0588-412b-9893-2574bbc7bf7f | yamanote.proxy.rlwy.net:44620 |
| CBE | b39c1fc4-0657-4469-bde4-2bf51cc6a664 | ff13b11b-af4c-4e08-82fc-eb9849da5077 | bb4d9208-3da0-4d96-95de-7eb784d3653e | nozomi.proxy.rlwy.net:11628 |

Host and port can change if a proxy is regenerated, so always re-read them from
`DATABASE_PUBLIC_URL`. Fetch the URLs without printing them, then test:

```python
# save as $SCRATCH/dbcheck.py ; run: python3 dbcheck.py
import json, subprocess, urllib.parse, os
T = {
 'ACC': ('9681a493-d648-4d63-87ab-b9fd362947b3','fddaebc0-f6f1-45ef-a840-b85874921328','b995d360-9df9-4165-ad46-4065bcc794c5'),
 'LAW': ('8154cf1a-658b-4548-9db0-a3493b70affb','a618aef4-cd72-4c23-bb64-63315b6a2589','dcb41c1c-5332-453e-b2cc-0df8cfe562c8'),
 'INV': ('715d4716-d182-4264-9ec5-6fcd021aaaab','fd50af09-2be6-4eb2-a9fc-23902394495e','1b1e5e3a-0588-412b-9893-2574bbc7bf7f'),
 'CBE': ('b39c1fc4-0657-4469-bde4-2bf51cc6a664','ff13b11b-af4c-4e08-82fc-eb9849da5077','bb4d9208-3da0-4d96-95de-7eb784d3653e'),
}
urls = {}
for k, (p, e, s) in T.items():
    q = {'query': 'query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }',
         'variables': {'p': p, 'e': e, 's': s}}
    r = json.loads(subprocess.check_output(['curl', '-sS', 'https://backboard.railway.com/graphql/v2',
        '-H', 'Content-Type: application/json', '-d', json.dumps(q)]))
    urls[k] = r['data']['variables']['DATABASE_PUBLIC_URL']
with open('dburls.json', 'w') as f: json.dump(urls, f)
os.chmod('dburls.json', 0o600)
for k, u in urls.items():
    h = urllib.parse.urlparse(u)
    ps = subprocess.run(['timeout', '20', 'psql', u + '?sslmode=require&connect_timeout=10', '-Atc',
        'select current_database(), now()'], capture_output=True, text=True)
    print(k, f'{h.hostname}:{h.port}', 'OK ' + ps.stdout.strip() if ps.returncode == 0 else 'FAIL ' + ps.stderr.strip()[:140])
```

**If all four say OK**, continue to Step 1.

**If they time out**, last session's diagnosis was: the local agent proxy answers `200 Connection
Established`, then the Postgres SSLRequest gets no reply (upstream egress drops it). Check in order:
1. The environment's Network access is Custom with `*.proxy.rlwy.net` (full domain, not `*.proxy`)
   in Allowed domains, and the default package-manager list kept.
2. The session was started AFTER that change. Changes only reach new containers.
3. If both are true and it still times out, the sandbox doesn't relay raw TCP on non-443
   ports. Stop and tell Arthur. The fallback is Arthur running each query locally with
   `railway link` + `railway connect Postgres` and pasting results. Write every query below
   into one paste-ready file so this costs him one sitting.

Do not continue to the DB-dependent steps on guesses.

## Step 1: A2 / A18 (LAW): dispute-suppression fix

1. Check PR #34 on `canadalawyers-backend` (branch `claude/a2-dispute-suppression-merge-ready`).
   If it isn't merged, ask Arthur to merge it (87 tests: 77 pass, 0 fail, 10 skipped; merge-tree clean).
2. Once it's merged, confirm the LAW deploy picked it up (Railway deployment for service
   `7fd783ea-3a34-4efc-a0ae-0ad911a0cf70` on the merge commit, status SUCCESS).
3. Close PR #33 with one comment pointing at #34. Note that the subjects file stays on
   `claude/resolve-dispute-writes-suppression`.
4. Read-only on LAW:
   `SELECT subject_ref, first_name, last_name FROM profile_suppressions WHERE subject_ref LIKE '2026-09-16/%';`
   If it returns zero rows, the 16 Sep runbook (on `claude/resolve-dispute-writes-suppression`)
   has to be run. Show Arthur the plan and get a yes before executing.

## Step 2: A1 (LAW): four removal requests

- **A1.2 (dispute D-8, profile 137283):** only after #34 is deployed:
  `POST /api/admin/disputes/8/resolve {"resolution":"removed"}`. Confirm with Arthur first.
- **A1.4 (Selemankhel):** no profile id yet. Read-only search of `scraped_lawyers` by name; MD Law
  is the old firm. Report the candidate rows to Arthur before any write.
- **A1.1 (hphpby) and A1.3 (Paik):** find the subjects and runbooks on the LAW branches
  (`git grep -i` across `docs/removals/` on all remote branches), resolve profile ids
  read-only, then propose the writes.
- After each removal, run the `verify` step and record exactly what it proved.

## Step 3: A3 (LAW): Astrup-Heber

Runbook and subjects are on `claude/keen-heisenberg-5cs7iq`, `docs/removals/2026-09-13-*`. Run
`discover` first: the profile id is still unresolved. Then plan, confirm with Arthur, execute,
verify. When describing what was proved: the API returns 410; the page URL is a 200 with
noindex (don't call it a 410); the suppression exists on LAW only; the Search Console request is filed by hand.

## Step 4: Gmail drafts → confirmation letters (never send)

Once a removal is verified, rewrite its interim draft as a confirmation. Remove the REVIEW
NOTE and fill [DATE]:
Astrup-Heber r2557375585530517381 · hphpby r3928933344019027489 · Raghuveer r-8711151723748911048 ·
Paik r409713427233630472 · Selemankhel r9073106410607534746. Leave the automation's daily drafts alone.

## Step 5: A4 (LAW): checkout auth gate

Gated on A1 to A3 being verified live. After that, review `claude/fix-lawyer-checkout-auth-gate` on the
backend (201ad3f) and frontend (37b001f), rerun the tests, and open the PRs. Don't merge them.
**A8** (Adebisi draft r-3816557363739355220, application #11) then gets the real checkout link
in place of `[CHECKOUT LINK]`. Arthur may supply it from the emailed form earlier.

## Step 6: A5: subscription truth (ACC #44, LAW #35, INV #18 open)

- Read the INV Stripe webhook log (Railway logs for the canadainvesting-backend service,
  `20d44307-47bf-4242-a06d-5cccf0b478de`, around 27 Aug) for the missed
  `customer.subscription.deleted`. Report why it was missed.
- Read-only: show the stale `advisor_subscriptions` row on INV. Propose the correcting UPDATE, then
  run it only on Arthur's yes. Stripe facts (30 Sep): LAW active with pause_collection; INV ended
  27 Aug; ACC both cancelled. Collectible MRR is $0, while the digest says $598.
- Before PR #44 merges: delete `HANDOFF-2026-09-30.md` from it (this note too, if it's carried there).

## Step 7: A15: snapcost

PR #16 is open (43/43). `DATA_DIR=/data` is on a volume, so data is not under the served root. The
encoded-path bypass still applies to the deployed 23 Sep build until #16 deploys. Ask Arthur to merge
it and confirm the deploy. Ask him whether `SITE_CODE` and `OFFICE_KEY` were ever rotated from the seed
(rotate if not), and count documents on the volume for the pilot-data question.

## Loose ends (raise, don't fix unasked)

- CBE gitleaks fails on `pull_request` events: the workflow needs `permissions: pull-requests: read`.
- Apollo key in plain text in CBE `SESSION_STATE.md` (~line 112): rotate and scrub, Arthur's call.

## Test baselines to hold

LAW main 84/74/0/10 · LAW A2 87/77/0/10 · LAW A5 90/80/0/10 · ACC 80/80 (after the 5 Oct merge) ·
INV 49/49 · CBE 2/2 · snapcost main 40/40, A15 branch 43/43.

## End of session

Update the BACKPRESSURE ledger for anything executed, write a fresh hand-off addendum, delete
`dburls.json` from the scratchpad, and push.
