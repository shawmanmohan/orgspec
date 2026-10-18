#!/bin/sh
# Pull-request step for the organisation's CI system. OrgSpec reads results back through the CI MCP server.
# Inputs (set by your CI): BASE_BRANCH, REPO (owner/name), PR_AUTHOR (GitHub login), GH_TOKEN (read access).
set -eu

# The base branch and full history are needed for the diff and for approval verification.
git fetch --quiet origin "${BASE_BRANCH:-main}"

# The constitution CI enforces comes from orgspec-config at its published commit.
if [ ! -d orgspec-config ]; then
  gh repo clone acme/orgspec-config orgspec-config -- --depth 1 --quiet
fi

orgspec check \
  --base "origin/${BASE_BRANCH:-main}" \
  --config ./orgspec-config \
  --persona engineer \
  --repo "${REPO}" \
  --author "${PR_AUTHOR}" \
  --json > orgspec-report.json || status=$?

# Human-readable summary in the CI log; the JSON report is kept as an artifact.
orgspec check --base "origin/${BASE_BRANCH:-main}" --config ./orgspec-config --persona engineer --repo "${REPO}" --author "${PR_AUTHOR}" || true
exit "${status:-0}"
