# VM Operations Hardening Decision

## Objective

Keep Chief's small production VM recoverable and repeatable as deployments
accumulate. A successful deployment must reclaim stale Docker images without
discarding the immediately previous rollback image, and both first boot and the
normal deployment path must converge Google Cloud apt repositories on one
non-conflicting signed configuration.

## Confirmed user decisions

- The user asked to address both operational follow-ups found during the live
  Chief health review and to open a pull request.
- The user explicitly requested the full `grill-plan-build` workflow, including
  artifact-backed planning, implementation, review, validation, publication,
  and PR creation.
- Work must follow Conventional Commits, use an isolated worktree, and push via
  an explicit remote head ref.

## Agent-recommended defaults

- Keep the running image and exactly one local rollback image. Tag the previous
  deployed digest as `chief:rollback`, then run non-`--all` Docker image pruning
  after the candidate is healthy so only older dangling images are reclaimed.
- Treat rollback tagging and pruning as best-effort post-success housekeeping.
  A cleanup failure must be visible on stderr but must not roll back an already
  healthy deployment.
- Add one repository-owned shell module that canonicalizes the Debian 12 Google
  Compute Engine, Cloud SDK, package-keyring, and Ops Agent apt suites into one
  source file using `/usr/share/keyrings/google-cloud.gpg`. The module must find
  competing Google apt definitions by repository content, be safe to run twice,
  and leave the OS Config managed source untouched.
- Invoke the apt-source module from the Terraform startup template and install
  and run it through the existing GitHub Actions SSH deployment path. This fixes
  both future first boots and the current long-lived VM after merge without a
  reboot.
- Use behavior-focused integration tests for both shell behaviors. Static
  repository-policy tests remain useful only for proving the scripts are wired
  into Terraform and the deployment workflow.

## Assumptions

- Chief remains on Debian 12. The current Terraform data source explicitly uses
  the `debian-12` image family, so the three `bookworm` suites are stable inputs.
- The image deployed immediately before a candidate is locally available when
  the candidate becomes healthy because it was the running container image at
  the start of the transaction.
- Artifact Registry remains the durable source for older immutable digests;
  local VM retention is limited to fast rollback of the immediately previous
  release.
- The existing deployment identity retains IAP SSH and sudo access already used
  by `.github/workflows/deploy.yml`.

## Open questions or user judgments

None. Repository code, live VM evidence, and the user's request settle the
delivery decisions needed for this bounded change.

## Accepted risks and failure modes

- `docker image prune` may fail because Docker is temporarily unavailable. The
  deployment remains successful, emits a warning, and retries cleanup on the
  next deployment.
- Tagging the previous digest may fail. In that case pruning is skipped so the
  previous image cannot be deleted accidentally.
- Apt-source reconciliation changes host configuration. It atomically writes
  `chief-google-cloud.list`, removes other `.list` or `.sources` files that
  reference `packages.cloud.google.com/apt`, preserves
  `google_osconfig_managed.*`, and never runs package upgrades from the
  deployment path.
- The existing SSH command does not currently use fail-fast shell semantics.
  The deployment wiring must enable `set -e` before invoking the apt module so a
  repair failure cannot be hidden by a later successful deployment command.
- A merge to `main` automatically deploys. Rollback remains the existing paired
  mechanism: prior immutable image plus its verified pre-deploy database.

## Constraints and non-goals

- Do not resize the VM, change swap, alter Docker health thresholds, or reschedule
  unattended upgrades.
- Do not prune application data, database backups, Artifact Registry images,
  containers, volumes, or build cache.
- Do not add compatibility aliases, alternate apt paths, cleanup flags, or a
  second deployment mode.
- Preserve the current transactional migration, health polling, database
  rollback, and immutable digest requirements.
- Preserve OS Config's managed apt source and all secret-redaction boundaries.

## Validation expectations

- A red-green deploy fixture proves successful cleanup order, failed-candidate
  exclusion, and best-effort failure behavior.
- A red-green apt fixture proves both `google-cloud*.list` and Debian's
  `gce_sdk.list` converge to one signed canonical file, a second run is
  byte-for-byte stable, the package-keyring suite remains available, and OS
  Config's managed source survives.
- `pnpm verify`, focused integration tests, shell syntax checks, Terraform
  formatting and validation, and `git diff --check` pass locally.
- The PR's Format, Lint, Test, and Build checks pass on GitHub.

## Repository and documentation boundaries

- Worktree: `/Users/kellen/development/github/kellen-miller/chief/.worktrees/vm-ops-hardening`
- Branch: `codex/vm-ops-hardening`
- Base ref: `origin/main` at `cdcc2e5e92c60bfab08406a1ec7dcc952f1e6969`
- Initial upstream: `origin/main`; publication must set the explicit remote
  branch `codex/vm-ops-hardening`.
- Expected files: `scripts/deploy.sh`, a new apt-source script,
  `infra/app/templates/startup.sh.tftpl`, `infra/app/main.tf`,
  `.github/workflows/deploy.yml`, integration/policy tests, and
  `docs/operations.md`.
- `CONTEXT.md` is intentionally skipped because this is operational mechanics,
  not shared domain language. An ADR is intentionally skipped because the
  decisions are reversible and local to VM provisioning/deployment.

## Source notes

This decision compiles the user's live-health follow-up request, the July 13
production inspection, `docs/operations.md`, `scripts/deploy.sh`,
`infra/app/templates/startup.sh.tftpl`, `.github/workflows/deploy.yml`,
`infra/app/main.tf`, `Dockerfile`, and the existing deployment/policy tests.
Live evidence showed a 76% full boot disk with 1.27 GB of reclaimable Docker
images and a repeatable apt `Signed-By` conflict between the image-provided
`google-cloud.list` and the repository-created Ops Agent source.
