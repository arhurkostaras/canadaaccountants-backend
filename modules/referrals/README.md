# Referral Rail Module (`modules/referrals/`)

Cross-platform referral network, Build Spec v1.2 (canonical copy:
`phronisi-ops/docs/REFERRAL_NETWORK_BUILD_SPEC.md`; execution state:
`phronisi-ops/docs/RAIL_STATUS.md`). One shared module deployed per platform;
per-platform values come from `config.js` (PRO_TABLE, CLIENT_TABLE,
SUPPRESSION_TABLE, PLATFORM_ID). Professional-facing routes live at
`/api/rail/referrals` on every platform (decision 2026-07-02: both ACC and LAW
monoliths already serve legacy peer-invite routes at `/api/referrals`; the two
systems never share a namespace). Server-to-server routes are `/api/network/*`,
HMAC-signed, no unauthenticated surface. All notify legs gate on
`REFERRAL_NOTIFY_ENABLED` (default off, spec 11.0).

## referral_code generation: BEFORE INSERT trigger (not an app-level hook)

`migrations/002_referral_code_trigger.sql` installs
`set_referral_code_on_pro_insert()` plus a BEFORE INSERT trigger on the
platform's professional table. Every new professional row gets a
`<PLATFORM>-XXXXXX` code at INSERT time, generated in the database itself.

Why a trigger and not code in the insert path: each monolith inserts into its
professional table from several independent code paths, and a hook on one path
leaves the others as silent gaps (the 2026-04-21 claim-side-effect failure
class: same visible state, missing side effects). A BEFORE INSERT trigger
covers every existing path and every future one by construction.

Per-platform instances:

| Platform | Pro table | Trigger | Production insert paths covered |
|---|---|---|---|
| ACC | `cpa_profiles` | `trg_cpa_profiles_referral_code` | 5 paths in server.js (lines ~200, 600, 4586, 5977, 7319) |
| LAW | `lawyer_profiles` | `trg_lawyer_profiles_referral_code` | 4 paths in server.js (Stripe webhook :175, admin create-profile :956, claim/instant :6226, admin backfill :7705) |
| INV | verify in repo at INV-1 | per pattern | count at INV-1 |
| CBE | `bankers` | per pattern | count at CBE-1 |

Design points:
- Explicit-code carve-out: a row inserted WITH `referral_code` already set is
  respected (controlled imports); the trigger only fills NULL.
- Code format: 6 chars from the 32-char alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
  (no I/L/O/U), platform prefix. Same alphabet in the trigger, the service
  generator (`service.js`), and the backfill script.
- Collision safety is layered: in-trigger existence loop (raises after 10
  attempts with a diagnostic message; 32^6 space makes genuine exhaustion
  impossible), plus the unique index from `001_referrals.sql` Section B as the
  hard backstop.
- Idempotent apply: function is CREATE OR REPLACE; the trigger is
  dropped-and-recreated. The DROP TRIGGER IF EXISTS statement drops only the
  trigger this file itself creates.

Verification recipe (run per platform after applying 002; both platforms passed):
1. In one transaction: INSERT a marked synthetic professional row
   (`RAIL-SELFTEST`), RETURNING `referral_code`; assert the trigger populated a
   well-formed `<PLATFORM>-[0-9A-Z]{6}` code; ROLLBACK.
2. Assert the professional-table row count is unchanged and zero selftest
   residue remains.
3. Proof runs on record: ACC 2026-07-01 (RAIL_STATUS ACC-3, rolled-back live
   INSERT); LAW 2026-07-02 (RAIL_STATUS LAW-4, code `LAW-SZV62F` generated then
   rolled back, count 1 -> 1, residue 0).

Backfill of pre-existing rows is a separate, gated step (dry-run-default
script, <=1,000-row batches, preview-before-execute): ACC coded 5/5 claimed
CPAs (2026-07-01); LAW coded its single claimed lawyer (2026-07-02).
