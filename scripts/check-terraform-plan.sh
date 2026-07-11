#!/usr/bin/env bash
set -euo pipefail

PLAN_JSON="${1:?usage: check-terraform-plan.sh PLAN_JSON}"
PROJECT_ID="${TF_VAR_project_id:?TF_VAR_project_id is required}"
RUNTIME_EMAIL="chief-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_MEMBER="serviceAccount:${RUNTIME_EMAIL}"
ALLOW_PROTECTED_DESTROY="${ALLOW_PROTECTED_DESTROY:-0}"
if [[ "$ALLOW_PROTECTED_DESTROY" != 0 && "$ALLOW_PROTECTED_DESTROY" != 1 ]]; then
  echo "ALLOW_PROTECTED_DESTROY must be 0 or 1" >&2
  exit 2
fi
if ! jq -e '(.resource_changes | type) == "array"' "$PLAN_JSON" >/dev/null; then
  echo "Terraform plan is missing a resource_changes array" >&2
  exit 1
fi

violations="$(jq -r \
  --arg runtime_email "$RUNTIME_EMAIL" \
  --arg runtime_member "$RUNTIME_MEMBER" \
  --argjson allow_protected_destroy "$ALLOW_PROTECTED_DESTROY" '
  def runtime_member:
    (.change.after.member // .change.before.member // "") == $runtime_member;
  def allowed_runtime_iam:
    (.change.after // .change.before) as $after |
    runtime_member
    and (((.change.actions | index("delete")) | not) or $allow_protected_destroy == 1)
    and (
      (.type == "google_project_iam_member"
        and (.address | test("^google_project_iam_member\\.runtime\\["))
        and (["roles/artifactregistry.reader", "roles/logging.logWriter", "roles/monitoring.metricWriter"]
          | index($after.role)))
      or (.type == "google_secret_manager_secret_iam_member"
        and (.address | test("^google_secret_manager_secret_iam_member\\.runtime\\["))
        and $after.role == "roles/secretmanager.secretAccessor")
      or (.type == "google_storage_bucket_iam_member"
        and (.address | test("^google_storage_bucket_iam_member\\.runtime_backups\\["))
        and (["roles/storage.objectCreator", "roles/storage.objectViewer"]
          | index($after.role)))
    );
  def protected_destroy:
    (.type == "google_storage_bucket"
      or .type == "google_compute_disk"
      or .type == "google_compute_instance"
      or .type == "google_secret_manager_secret")
    and (.change.actions | index("delete"));
  def iam_change:
    (.type | test("^google_.*iam_"))
    and .change.actions != ["no-op"];
  def privileged_compute_change:
    .type == "google_compute_instance"
    and .change.actions != ["no-op"]
    and .change.after != null
    and ([.change.after.service_account[]?.email] != [$runtime_email]);
  def forbidden_identity_resource:
    (.type | test("^google_(service_account_key|iam_workload_identity_pool(_provider)?|.+_iam_custom_role)$"))
    and .change.actions != ["no-op"];
  .resource_changes[]?
  | if protected_destroy and ($allow_protected_destroy == 0) then
      "protected resource: \(.address)"
    elif iam_change and (allowed_runtime_iam | not) then
      "unexpected IAM change: \(.address)"
    elif privileged_compute_change then
      "unexpected compute service account: \(.address)"
    elif forbidden_identity_resource then
      "unexpected identity resource: \(.address)"
    else empty end
' "$PLAN_JSON")"
if [[ -n "$violations" ]]; then
  echo "Terraform plan violates Chief deployment policy:" >&2
  echo "$violations" >&2
  exit 1
fi
