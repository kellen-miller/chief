# Harden Chief's VM deployment and package sources

This ExecPlan is a living document. The sections `Progress`, `Surprises &
Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to
date as work proceeds. Maintain this document in accordance with
`.agent/PLANS.md`.

## Purpose / Big Picture

Chief runs on a 10 GB boot disk. Repeated immutable-image deployments currently
leave every older image behind, and nine releases consumed 1.4 GB after one day.
After this change, every healthy deployment retains the running image and one
fast local rollback image while reclaiming older dangling images. Operators can
observe the retained `chief:rollback` tag and a smaller `docker system df`
reclaimable total without changing application data or the rollback database.

The VM's Debian image also ships Google Cloud apt suites without an explicit
`Signed-By`, while the startup template adds a differently signed Ops Agent
suite at the same package URL. Apt rejects that mixed configuration. After this
change, one repository-owned shell module replaces competing Google package
definitions with one signed, Debian 12 source file. Both initial
provisioning and ordinary deploys invoke that module, so a new VM boots cleanly
and the existing VM converges without a reboot.

Today, deployment cleanup policy would have to be improvised by an operator,
and apt repository ownership is split between the base image and the startup
template. The intended complexity dividend is two deep shell boundaries:
`scripts/deploy.sh` owns post-success image retention, while the new apt module
owns the complete Google Cloud source-file shape. Callers only invoke those
boundaries and do not duplicate ordering or file-selection knowledge.

## Progress

- [x] (2026-07-13 23:33Z) Created isolated worktree and passed the clean baseline
      (`pnpm verify`: 27 files and 203 tests passed).
- [x] (2026-07-13 23:37Z) Completed repository- and live-evidence-backed grill.
- [x] (2026-07-13 23:38Z) Drafted decision, metadata, and this ExecPlan.
- [x] (2026-07-14 00:00Z) Adversarially reviewed the planning packet and
      resolved two high- and two medium-severity findings before implementation.
- [x] (2026-07-14 00:11Z) Added red-green behavior tests for image retention,
      cleanup failures, apt-source convergence, idempotence, and pre-mutation key
      validation.
- [x] (2026-07-14 00:11Z) Implemented both operational boundaries and wired apt
      convergence into first boot and fail-fast existing-host deployment.
- [x] (2026-07-14 00:12Z) Updated operations documentation and living-plan
      evidence.
- [x] (2026-07-14 00:15Z) Ran the fresh-eyes recent-work review, confirmed the
  Moby prune semantics, and corrected one operator-doc wording issue.
- [ ] Run formal and adversarial implementation reviews.
- [x] (2026-07-14 00:16Z) Ran all local validation and created the reviewed
  Conventional Commit.
- [ ] Push the explicit remote ref, open the PR, and verify the four required
  GitHub checks.

## Surprises & Discoveries

- Observation: The startup script's first `apt-get update` succeeds only because
  it deletes the repository-created Ops Agent source first. Its second update
  fails after that signed source is recreated beside the image's unsigned
  `google-cloud.list`.
  Evidence: Production contains unsigned `google-compute-engine-bookworm-stable`
  and `cloud-sdk-bookworm` lines plus a signed
  `google-cloud-ops-agent-bookworm-all` line, and apt logged `Conflicting values
set for option Signed-By`.
- Observation: Non-`--all` `docker image prune` is the narrow cleanup primitive
  because the production accumulation is dangling images. The previous digest
  needs a stable tag before pruning, while the running candidate is protected by
  its active container.
  Evidence: `docker system df -v` showed one active image and eight untagged
  images; `docker system df` reported 1.27 GB reclaimable.
- Observation: Debian 12's GCE image build owns `gce_sdk.list`, not only the
  `google-cloud*.list` filenames observed on the running VM, and includes a
  package-keyring update suite.
  Evidence: The upstream Debian cloud-image configuration names
  `gce_sdk.list`; all four selected suites returned HTTP 200 from
  `packages.cloud.google.com/apt` during adversarial review.
- Observation: The remote deploy shell does not enable `set -e`, so a newly
  inserted middle command could fail without affecting the final SSH status.
  Evidence: `.github/workflows/deploy.yml` currently relies on explicit guards
  and the exit status of its final `deploy.sh` invocation.
- Observation: The adversarial reviewer initially claimed digest references
  would defeat non-`--all` pruning, then overturned that claim after reading the
  Moby (Docker Engine's upstream implementation) classic image-store path.
  Evidence: Moby prunes unused canonical digest references when there is no
  tagged reference; the retained prior digest is protected by
  `chief:rollback`, and the candidate is protected by its running container.
- Observation: Each new behavior test failed at the expected public seam before
  its production change: missing tag/prune calls, non-best-effort cleanup
  failures, missing apt script, and absent Terraform/workflow wiring.
  Evidence: focused Vitest runs reported the expected assertions, followed by
  11 passing repository-policy tests and 7 passing focused integration tests.

## Decision Log

- Decision: Retain one previous image as `chief:rollback`, then prune dangling
  images only after candidate readiness succeeds.
  Rationale: This preserves fast rollback and cannot interfere with migration
  rollback, which completes before the cleanup phase.
  Date/Author: 2026-07-13 / Codex
- Decision: Skip pruning when rollback tagging fails, and never fail or reverse a
  healthy deployment because housekeeping failed.
  Rationale: Availability and preservation of the prior image outrank disk
  cleanup; the next deployment provides another retry.
  Date/Author: 2026-07-13 / Codex
- Decision: Canonicalize four Debian 12 Google Cloud suites in one signed source
  file and leave `google_osconfig_managed.*` alone.
  Rationale: Terraform pins the Debian 12 family; retaining the Compute Engine,
  Cloud SDK, package-keyring, and Ops Agent suites preserves base-image package
  maintenance while one canonical owner eliminates conflicting apt options.
  Date/Author: 2026-07-13 / Codex
- Decision: Install and run the apt module from both startup metadata and the
  existing SSH deploy path.
  Rationale: Metadata changes alone do not execute on the already-running VM;
  the deploy path provides immediate convergence after merge.
  Date/Author: 2026-07-13 / Codex
- Decision: Detect competing Google sources by repository content and make the
  remote deployment shell fail fast.
  Rationale: Base-image filenames vary, while the repository URL is the stable
  ownership signal; `set -e` prevents a failed repair from being hidden by the
  later deployment transaction.
  Date/Author: 2026-07-14 / Codex

## Outcomes & Retrospective

Implementation is complete at the planned seams. Review and full validation are
partially complete. The recent-work pass found no code defect; formal and
adversarial reviews remain. Completion depends on GitHub evidence, not the
existence of this plan or local green tests.

## Context and Orientation

`scripts/deploy.sh` is copied to `/opt/chief/deploy.sh` by
`.github/workflows/deploy.yml` and run as root for every merge to `main`. It
pulls an immutable digest, backs up the SQLite database, migrates, writes the new
digest to `/var/lib/chief/deploy.env`, starts `chief.service`, and polls the
localhost readiness endpoint. Its `rollback` function restores the database and
previous digest when a candidate fails. Image retention must happen after the
readiness loop and after the error trap is disabled so housekeeping never enters
that database rollback path.

Docker's classic image store treats an unused image with no tagged reference as
dangling even when it was pulled by immutable digest. The production VM's old
immutable images therefore become prune candidates after newer deploys.
`docker image prune --force` removes only that narrow set; adding `--all` would
broaden deletion to every unused tagged image and is forbidden here. Tagging
the previous digest as `chief:rollback` protects exactly one fast rollback
image.

`infra/app/templates/startup.sh.tftpl` is rendered into Compute Engine metadata
by `templatefile` in `infra/app/main.tf`. It first installs curl, GnuPG, and
Docker from the image's existing apt configuration, then creates the key and Ops
Agent source. The new `scripts/configure-google-cloud-apt.sh` will own the source
files after the key exists. Terraform will inject its file contents into the
startup template, just as it already injects `scripts/run-container.sh`.

The GitHub deploy workflow already copies shell scripts over Identity-Aware
Proxy (IAP) SSH tunneling and installs them under `/opt/chief`. Extend that
existing step to copy, install, and invoke the apt-source module before running
the deployment transaction. The module only rewrites source definitions; it
does not call `apt-get` in the ordinary deploy path. First boot continues to
call `apt-get update` and install the CLI and Ops Agent after canonicalization.

Tests use Vitest and fake executables in temporary directories. The current
`test/integration/deploy-script.test.ts` records fake Docker calls and exercises
successful and failed candidates. A new apt integration test can point the
module at a temporary source directory and keyring using environment overrides,
run it twice, and inspect files without root or network access. Static wiring
assertions belong in `test/unit/repository-policy.test.ts`.

## Plan of Work

### Milestone 1: Specify both shell behaviors with failing tests

Extend `test/integration/deploy-script.test.ts` so the fake Docker executable
understands `image tag` and `image prune`. For a healthy candidate, assert that
the previous digest is tagged `chief:rollback` only after readiness succeeds and
that `docker image prune --force` follows the tag. For a failed candidate,
assert that neither call occurs. Add a fixture mode where image tagging fails;
the deployment must still exit zero, print a cleanup warning, and omit pruning.
Add a separate prune-failure mode that proves the rollback tag remains, the
deployment still exits zero, and a distinct redacted warning is printed. These
assertions must fail before production code changes.

Create `test/integration/google-cloud-apt-source.test.ts`. In a temporary
directory, create a legacy unsigned `google-cloud.list`, a separately signed
`google-cloud-ops-agent.list`, Debian's `gce_sdk.list`, an unrelated apt source,
and a sentinel `google_osconfig_managed.list`. Create a non-empty fake keyring,
run the new
script path twice with `GOOGLE_CLOUD_APT_SOURCES_DIR` and
`GOOGLE_CLOUD_APT_KEYRING` pointed at the fixture, then assert that the second
output is identical to the first. Exactly one repository-owned Google source
file must remain, all four expected bookworm suites must use the same
`signed-by` path, and the sentinel and unrelated source must be unchanged. The
test initially fails because the script does not exist.

Run from the worktree:

    pnpm vitest run --project integration test/integration/deploy-script.test.ts test/integration/google-cloud-apt-source.test.ts

Record the expected failures in `Surprises & Discoveries`, then implement only
enough behavior to make them pass.

### Milestone 2: Concentrate apt source ownership

Add `scripts/configure-google-cloud-apt.sh`. It accepts no command-line options.
For testability, it reads `GOOGLE_CLOUD_APT_SOURCES_DIR` and
`GOOGLE_CLOUD_APT_KEYRING`, defaulting to `/etc/apt/sources.list.d` and
`/usr/share/keyrings/google-cloud.gpg`. It fails before mutation if the keyring
is missing or empty and creates the source directory. It writes and validates a
temporary file containing the Compute Engine, Cloud SDK, package-keyring, and
Ops Agent bookworm suites with the common keyring. Only after the complete
temporary file exists does it set mode `0644` and atomically replace
`chief-google-cloud.list`; it then removes other `.list` and `.sources` files
whose content references `packages.cloud.google.com/apt`, except
`google_osconfig_managed.*`. A trap removes an abandoned temporary file. A
second run must produce the same bytes and file set.

In `infra/app/main.tf`, pass the script contents as a `templatefile` variable. In
`infra/app/templates/startup.sh.tftpl`, install it under `/opt/chief` and invoke
it after the keyring is downloaded but before the second `apt-get update`.
Retain the early removal of `google-cloud-ops-agent.list` so the image's initial
apt configuration remains usable long enough to install curl and GnuPG. Embed
the script with a dedicated heredoc terminator such as
`CHIEF_GOOGLE_APT_SCRIPT`, not the generic `EOF` used inside shell modules, so a
heredoc in the injected file cannot terminate the startup template's outer
write early.

In `.github/workflows/deploy.yml`, copy the new script with the existing deploy
files, install it under `/opt/chief`, and invoke it before installing/running the
deployment transaction. Prefix the remote command with `set -e` so a failed apt
repair stops before the deployment transaction while the existing Chief process
remains available. Update `test/unit/repository-policy.test.ts` to assert the
Terraform injection, startup invocation, workflow copy/install/invoke sequence,
and fail-fast remote shell rather than duplicating the shell module's behavior.
The wiring test must also prove that the startup template uses a script-specific
heredoc terminator.

Run:

    pnpm vitest run --project integration test/integration/google-cloud-apt-source.test.ts
    pnpm vitest run --project unit test/unit/repository-policy.test.ts
    bash -n scripts/configure-google-cloud-apt.sh infra/app/templates/startup.sh.tftpl
    terraform fmt -check -recursive infra

Acceptance is one deterministic signed source configuration in the fixture and
static proof that both first boot and existing-host deployment invoke it.

### Milestone 3: Retain rollback while reclaiming old images

In `scripts/deploy.sh`, add post-readiness housekeeping after `trap - ERR`. When
`PREVIOUS_IMAGE` is non-empty and differs from `CANDIDATE_IMAGE`, tag it as
`chief:rollback`. If that tag fails, print a redacted warning and skip pruning.
Otherwise run `docker image prune --force`; if pruning fails, print a redacted
warning and continue. Do not use `--all`, remove containers, or expose the image
reference in warnings. Leave the existing success JSON as the final output.

Run:

    pnpm vitest run --project integration test/integration/deploy-script.test.ts
    bash -n scripts/deploy.sh

Acceptance is ordering evidence in the fake command log, unchanged candidate
rollback behavior, and zero exit status for independently simulated tag and
prune failures.

### Milestone 4: Document, review, and publish

Update `docs/operations.md` with the local retention contract, diagnostic
commands (`docker system df` and `docker image ls`), the best-effort cleanup
behavior, and the canonical apt-source ownership. State that Artifact Registry
retention is unchanged and that database/image rollback remains paired.

Run the normal review against this decision and plan, then a formal diff review
against `origin/main`, and finally an adversarial implementation review. Resolve
verified critical/high findings and bounded lower-severity findings. Update this
plan's living sections after every correction.

Run the complete local gate from the worktree:

    pnpm verify
    bash -n scripts/*.sh infra/app/templates/startup.sh.tftpl
    terraform fmt -check -recursive infra
    terraform -chdir=infra/app init -backend=false -input=false
    terraform -chdir=infra/app validate -no-color
    git diff --check

Expect every command to exit zero and `pnpm verify` to keep meaningful coverage
at or above the repository thresholds. Commit only intended paths using a
Conventional Commit subject of at most 50 characters. Push exactly:

    git push origin HEAD:refs/heads/codex/vm-ops-hardening

Open a PR against `main` that explains the live evidence, behavior changes,
rollback safety, and validation. Wait for Format, Lint, Test, and Build to pass;
do not merge because the user asked for a PR, not a production rollout.

## Concrete Steps

All commands run from
`/Users/kellen/development/github/kellen-miller/chief/.worktrees/vm-ops-hardening`.
Use the milestone commands in order. Keep focused red-green output and final
validation summaries in this document. Inspect `git status --short` before
staging and stage only the work-item, scripts, Terraform/template, workflow,
tests, and documentation named here.

## Validation and Acceptance

The change is accepted locally when the two new behavior seams pass, the failed
candidate still restores its database and digest, cleanup failure leaves a
healthy deployment successful, source convergence is idempotent, OS Config's
file survives, shell syntax and Terraform validation pass, and `pnpm verify`
passes without weakening coverage.

The delivery is accepted when the explicit branch ref is pushed, a PR targeting
`main` exists, and GitHub reports Format, Lint, Test, and Build successful. This
task intentionally stops before merge; production convergence occurs through
the existing merge-to-main deployment.

## Idempotence and Recovery

The apt module is deliberately repeatable and writes atomically. If it exits
while preparing the temporary file, the existing source files remain. The only
small replacement window is the adjacent remove-and-rename sequence after the
complete file is ready; rerunning after interruption recreates the same source.
Tests must exercise two successful runs. The module does not touch
`google_osconfig_managed.list`.

The deployment transaction remains retryable. Candidate failure occurs before
cleanup and uses the existing database/image rollback. Cleanup occurs only after
readiness. A failed rollback tag prevents pruning; a failed prune leaves disk
state unchanged and the next healthy deploy retries. Reverting the commit
restores the old deployment behavior, while a canonical apt file already
written remains a valid Debian configuration and needs no reverse migration.

## Artifacts and Notes

Initial live evidence:

    Images          9 total, 1 active, 1.401 GB, 1.27 GB reclaimable
    /               9.7 GB total, 7.0 GB used, 2.2 GB available, 76%
    apt error       Conflicting values set for option Signed-By

Baseline evidence:

    Test Files  27 passed (27)
    Tests       203 passed (203)
    pnpm verify exit 0

Post-implementation local evidence:

    Test Files  28 passed (28)
    Tests       208 passed (208)
    Coverage    89.4% statements, 81.64% branches, 89.72% functions,
                90.44% lines
    pnpm verify, bash -n, terraform fmt/init/validate, git diff --check,
    shellcheck, and actionlint exit 0

## Interfaces and Dependencies

`scripts/configure-google-cloud-apt.sh` is the sole interface for canonical
Google Cloud apt sources. Its only test seams are the two environment-variable
path overrides; production callers pass no arguments. It uses only Bash,
`install`, `mktemp`, `rm`, `chmod`, and `mv`, all already available before the
second apt update. It does not own key download or package installation.

`scripts/deploy.sh` remains the sole deployment transaction. Its externally
visible inputs stay unchanged: `--image IMAGE@sha256:DIGEST` plus existing data
and runtime environment overrides. The new `chief:rollback` tag is local
operational state, not a new caller input. No new package dependency, Terraform
resource, public API, or compatibility path is introduced.

Revision note (2026-07-13): Initial plan compiled from the completed operational
grill and live VM evidence. Improvement pass 1 tightened interruption safety so
the canonical source is fully staged before legacy definitions are removed.
Improvement pass 2 prevented nested-heredoc delimiter collisions when Terraform
injects the repository-owned shell module into startup metadata. Improvement
pass 3 added independent prune-failure coverage so both best-effort cleanup
branches are observable rather than inferred from the tag-failure case.

Revision note (2026-07-14): Adversarial review expanded source discovery from a
filename glob to repository-content ownership, retained Debian's package-keyring
suite, changed replacement order so the canonical file exists before legacy
cleanup, and required fail-fast semantics in the remote deployment shell. It
also verified and retained the narrow non-`--all` Docker prune design.
