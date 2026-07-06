#!/usr/bin/env bash
# BP-007 pre-deploy base guard. railway up ships the local TREE with no base
# check; on 2026-07-05 two stale-base deploys silently regressed production
# (LAW ~22h, INV ~24h). Every manual deploy goes through this script.
set -euo pipefail
SERVICE="${1:?usage: scripts/safe-deploy.sh <railway-service-name>}"

git fetch origin --quiet
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "REFUSED: HEAD does not contain origin/main (BP-007)." >&2
  echo "Expected: the deploy tree includes every commit on origin/main." >&2
  echo "Missing from HEAD:" >&2
  git log --oneline HEAD..origin/main | head -20 >&2
  echo "Fix: git merge origin/main, verify, re-run." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: uncommitted changes present; railway up ships the TREE, not HEAD:" >&2
  git status --porcelain | head -10 >&2
fi
echo "Base check passed: HEAD contains origin/main ($(git rev-parse --short origin/main))."
railway status
railway up --service "$SERVICE" --detach
