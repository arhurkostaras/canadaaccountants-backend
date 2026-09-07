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
# Upload THIS checkout. Without --path-as-root, railway up archives the "project
# directory" (the main checkout the Railway link was made in), so a deploy run
# from a git worktree silently ships a different tree than the one the base
# check above just approved (observed 2026-09-07 on canadalawyers-backend: two
# worktree deploys reported SUCCESS and shipped the parent checkout's branch).
TREE="$(git rev-parse --show-toplevel)"
echo "Uploading tree: $TREE ($(git rev-parse --short HEAD))"
railway up --path-as-root --service "$SERVICE" --detach "$TREE"
