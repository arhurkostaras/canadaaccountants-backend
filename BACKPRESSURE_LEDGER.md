# Backpressure Ledger — Personal Platforms

Canonical backpressure ledger for the four personal platforms (CanadaAccountants,
CanadaLawyers, CanadaInvesting, CanadaBusinessExits). Referenced from the
Backpressure Protocol in the global agent config (~/.claude/CLAUDE.md).

Append only. To retire a row, set Status to retired and give the reason in Notes.
Never delete a row.

Status values:
- pending: logged, mechanism NOT yet encoded (no code applied).
- active: mechanism encoded and enforcing.
- retired: was active, now removed; reason recorded in Notes.

Scope names the repos where the defect can occur. There is no live shared module
across these repos, so a code-level constraint added to one does NOT propagate;
each repo in Scope must get its own copy. Never write "shared template" in Scope.

| ID | Date | Mistake observed twice | Class | Mechanism | Rung | Scope | Status | Notes |
|----|------|------------------------|-------|-----------|------|-------|--------|-------|
| BP-001 | 2026-06-06 | Bounced addresses written through the unsubscribe path, corrupting unsubscribe/deliverability metrics | invariant | Reason-enum CHECK or FK guarding the bounce/unsubscribe write path. Tables are already separate, so do NOT specify a table split | 1 unrepresentable | canadaaccountants-backend, canadalawyers-backend, canadainvesting-backend (schema.sql); canadabusinessexits-backend as a NEW migration (CBE is migrations-only, no schema.sql) | pending | Ground truth 2026-06-06: ACC/LAW store unsubscribes as table `outreach_unsubscribes` and bounces as columns (`bounced`, `bounced_at`, `total_bounced`); INV has both in schema.sql plus `outreach_unsubscribes`; CBE migrations-only (`unsubscribe_tokens` table + `bounce_rate`/`bounced_count`). Tables already separate, so the leftmost mechanism is a write-path reason-enum CHECK/FK, not a table split. BEFORE marking active: confirm whether the wrong-write still recurs in the write paths; if they are already clean, reclassify as "regression insurance," not a live fix. No code applied. |
| BP-002 | 2026-06-06 | Sentry.init called after the express require, missing setup-time errors | invariant | ESLint rule (sentry-before-express), leftmost form; applied per repo (no shared eslint config exists) | 2 lint | canadaaccountants-backend, canadalawyers-backend, canadainvesting-backend (CBE exempt) | pending | Ground truth 2026-06-06: real in ACC/LAW/INV (server.js requires `@sentry/node` at L1, `express` at L2, but `Sentry.init` runs at L23-42, after the express require). CBE already satisfied via `instrument.js` (Sentry init-first in a separately pre-required file), so CBE is exempt. First encoding = BP-002 on canadaaccountants-backend as a separate proof step. Longer-term option: migrate ACC/LAW/INV to CBE's instrument.js pattern (structural fix rather than lint-enforced). No code applied. |
| BP-003 | 2026-06-06 | Investing Postgres service link dropped after deploy | invariant | deploy-all.sh enforces it: `set -e` plus automatic Investing re-link after deploy | 4 build check | canadainvesting-backend, canadalawyers-backend, canadaaccountants-backend (the 3 backends deploy-all.sh covers) | active | Ground truth 2026-06-06: mechanism already LIVE in `~/deploy-all.sh` (`set -e` at L5 + "re-link Investing to canadainvesting-backend" step at end). OPEN hardening action: the canonical script lives loose in `~/` (in no repo); put it under version control so the stale copy at `~/Downloads/platforms/shared/deploy-all.sh` cannot be mistaken for canonical. OPEN: CanadaBusinessExits has a SEPARATE deploy path not covered by deploy-all.sh; verify how CBE deploys and whether it needs the same re-link safety. |
