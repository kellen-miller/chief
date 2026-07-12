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

ruleset_payload="$(jq -n '{
  name: "default",
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
      required_approving_review_count: 0,
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
environment_payload="$(jq -n '{
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true
  }
}')"
branch_policy_payload="$(jq -n '{name: "main", type: "branch"}')"

if [[ "$DRY_RUN" == true ]]; then
  jq -n \
    --argjson ruleset "$ruleset_payload" \
    --argjson environment "$environment_payload" \
    --argjson branch_policy "$branch_policy_payload" \
    '{ruleset: $ruleset, environment: $environment, branch_policy: $branch_policy}'
  exit 0
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
printf '%s\n' "$ruleset_payload" >"$temporary_directory/ruleset.json"
printf '%s\n' "$environment_payload" >"$temporary_directory/environment.json"
printf '%s\n' "$branch_policy_payload" >"$temporary_directory/branch-policy.json"

ruleset_id="$(gh api "repos/$REPOSITORY/rulesets" \
  --jq '.[] | select(.name == "default" and .target == "branch") | .id' \
  | head -n 1)"
if [[ -n "$ruleset_id" ]]; then
  gh api --method PUT "repos/$REPOSITORY/rulesets/$ruleset_id" \
    --input "$temporary_directory/ruleset.json"
else
  gh api --method POST "repos/$REPOSITORY/rulesets" \
    --input "$temporary_directory/ruleset.json"
fi

gh api --method PUT "repos/$REPOSITORY/environments/production" \
  --input "$temporary_directory/environment.json"
policies="$(gh api "repos/$REPOSITORY/environments/production/deployment-branch-policies")"
while IFS= read -r policy_id; do
  gh api --method DELETE \
    "repos/$REPOSITORY/environments/production/deployment-branch-policies/$policy_id"
done < <(jq -r '.branch_policies[]? | select(.name != "main") | .id' <<<"$policies")
if ! jq -e '.branch_policies[]? | select(.name == "main")' <<<"$policies" >/dev/null; then
  gh api --method POST \
    "repos/$REPOSITORY/environments/production/deployment-branch-policies" \
    --input "$temporary_directory/branch-policy.json"
fi
