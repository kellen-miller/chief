#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == --dry-run ]]; then DRY_RUN=true; shift; fi
if [[ $# -ne 0 ]]; then echo 'usage: configure-github-ruleset.sh [--dry-run]' >&2; exit 2; fi

REPOSITORY="${GITHUB_REPOSITORY:-}"
if [[ -z "$REPOSITORY" ]]; then
  if [[ "$DRY_RUN" == true ]]; then REPOSITORY='kellen-miller/chief';
  else REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"; fi
fi

payload="$(jq -n '{
  name: "Protect main",
  target: "branch",
  enforcement: "active",
  conditions: {ref_name: {include: ["~DEFAULT_BRANCH"], exclude: []}},
  bypass_actors: [],
  rules: [
    {type: "deletion"},
    {type: "non_fast_forward"},
    {type: "pull_request", parameters: {
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 1,
      required_review_thread_resolution: true
    }},
    {type: "required_status_checks", parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: [
        {context: "Format"}, {context: "Lint"},
        {context: "Test"}, {context: "Build"}
      ]
    }}
  ]
}')"

if [[ "$DRY_RUN" == true ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT
printf '%s\n' "$payload" >"$temporary"
gh api --method POST "repos/$REPOSITORY/rulesets" --input "$temporary"
