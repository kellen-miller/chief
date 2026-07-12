# GCP bootstrap

Chief targets Terraform 1.15.8 and Google provider 7.39.0. Application state uses a versioned GCS backend. Bootstrap identity/state and application infrastructure are separate roots to limit blast radius.

## 1. Project and local authentication

Create or select a billing-enabled GCP project. The `e2-micro`, standard disks, and storage may fit applicable free-tier allowances, but the static external IPv4 is billable. Authenticate an owner locally:

```bash
gcloud auth application-default login
gcloud config set project YOUR_PROJECT
cp infra/bootstrap/terraform.tfvars.example infra/bootstrap/terraform.tfvars
```

Fill the project and globally unique state bucket. Bootstrap begins with ignored local state because the bucket does not exist yet:

```bash
mkdir -p infra/bootstrap/.local-state
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap plan \
  -state=.local-state/terraform.tfstate \
  -out=.local-state/bootstrap.tfplan
terraform -chdir=infra/bootstrap apply \
  -state=.local-state/terraform.tfstate \
  .local-state/bootstrap.tfplan
```

Review the plan before applying. Then migrate the bootstrap state into its protected prefix:

```bash
cp infra/bootstrap/.local-state/terraform.tfstate infra/bootstrap/terraform.tfstate
cp infra/bootstrap/backend.hcl.example infra/bootstrap/backend.hcl
# Fill the real bucket in backend.hcl.
terraform -chdir=infra/bootstrap init -migrate-state \
  -backend-config=backend.hcl
terraform -chdir=infra/bootstrap plan -var-file=terraform.tfvars
rm -f infra/bootstrap/terraform.tfstate infra/bootstrap/terraform.tfstate.backup
```

Keep the ignored `.local-state` copy until the remote plan is verified, then archive or remove it securely.

## 2. Application variables and secrets

Copy `infra/app/terraform.tfvars.example`, fill the non-secret values, and run an owner-reviewed first application plan/apply. Terraform creates secret containers but never secret versions. Seed values out of band:

```bash
printf '%s' "$DISCORD_TOKEN" | \
  gcloud secrets versions add chief-discord-token --data-file=-
printf '%s' "$OPENAI_API_KEY" | \
  gcloud secrets versions add chief-openai-api-key --data-file=-
```

Do not pass those values through Terraform variables; data-source secret reads would persist them in state.

## 3. GitHub configuration

Create a GitHub environment named `production`. The approved design deploys automatically after a green pull request merges to `main`, so do not add a required reviewer unless you want a second manual gate. Restrict the environment to the custom `main` branch policy.

Set repository/environment variables from bootstrap outputs and application inputs:

- `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ZONE`
- `GCP_TERRAFORM_STATE_BUCKET`
- `GCP_PR_WIF_PROVIDER`, `GCP_PRODUCTION_WIF_PROVIDER`
- `GCP_TF_PLAN_SERVICE_ACCOUNT`, `GCP_TF_APPLY_SERVICE_ACCOUNT`, `GCP_DEPLOY_SERVICE_ACCOUNT`
- `CHIEF_BACKUP_BUCKET`, `CHIEF_ALERT_EMAIL`
- the four `DISCORD_*_ID` variables used in the workflows

The PR provider accepts only `kellen-miller/chief` pull-request tokens and can impersonate only the read-only plan account. The production provider requires the exact subject `repo:kellen-miller/chief:environment:production` on a push. No service-account key is stored in GitHub.

Run `scripts/configure-github-ruleset.sh --dry-run` to inspect the proposed main-branch ruleset and production environment policy, then run it without `--dry-run` when ready. The ruleset requires pull requests and the Format, Lint, Test, and Build checks, but requires zero approvals so the solo maintainer can merge a green PR.

## Rollback and state recovery

Application deployment uses an immutable image digest and saves a verified SQLite backup before migration. Candidate failure restores the prior digest and database. GCS state versioning is the Terraform state recovery source; never edit state manually. For decommissioning, first create and review `terraform plan -destroy`, inspect every implicit dependent, remove explicit `prevent_destroy` only in a dedicated reviewed change, and then request owner confirmation before any destroy.
