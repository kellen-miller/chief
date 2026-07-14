# Adversarial Plan Review

The external review ran two independent passes against the planning packet and
current deployment code. Its raw transcript is retained locally but ignored
because the reviewer recursively expanded its research after the release-
changing questions were settled. The findings below include only claims
verified against repository code, upstream package endpoints, or Moby source.

## 1. High: apt reconciliation could fail silently

- Artifact: `.github/workflows/deploy.yml`
- Evidence: the remote `gcloud compute ssh --command` body does not enable
  `set -e`. Its current final command is `sudo /opt/chief/deploy.sh`, so a new
  canonicalizer inserted earlier as a standalone command could fail while the
  deployment continues and determines the SSH exit status.
- Why it matters: GitHub could report a green deployment while the host retains
  the exact `Signed-By` conflict this change is intended to repair.
- Resolution: prefix the remote command with `set -e` and test that apt
  reconciliation is installed and invoked before the deployment transaction.

## 2. High: filename-only cleanup misses Debian's source file

- Artifact: `decision.md`, `execplan.md`
- Evidence: Debian 12's GCE image build config uses
  `/etc/apt/sources.list.d/gce_sdk.list`. Its Google repository entries include
  `cloud-sdk-bookworm` and
  `google-cloud-packages-archive-keyring-bookworm-stable`. The draft plan only
  removed `google-cloud*.list`, so `gce_sdk.list` could survive beside the new
  signed source and preserve conflicting or duplicate repository ownership.
- Why it matters: a newly provisioned VM could still fail `apt-get update`, and
  removing the source without replacing its keyring-update suite would stop
  signing-key maintenance.
- Resolution: identify legacy `.list` and `.sources` files by
  `packages.cloud.google.com/apt` content, preserve
  `google_osconfig_managed.*`, and converge four verified Debian 12 suites into
  `chief-google-cloud.list`: Compute Engine, Cloud SDK, package keyring, and Ops
  Agent.

## 3. Medium: prune semantics needed primary-source confirmation

- Artifact: `execplan.md`
- Evidence: the initial review incorrectly inferred that a `RepoDigest` makes a
  digest-pulled image ineligible for default pruning. Moby's classic image-store
  prune path instead treats an image with no tagged reference as dangling and
  deletes its canonical digest reference when the image is unused. All four
  planned Google apt suites also returned HTTP 200 during review.
- Why it matters: using `--all` to react to the false alarm would delete every
  unused image, including the deliberately retained rollback image.
- Resolution: keep `docker image prune --force` without `--all`, tag the prior
  digest first, and retain the fake-Docker ordering and failure tests. Record
  production disk reclamation as post-merge operational evidence rather than
  mutating a developer Docker daemon in tests.

## 4. Medium: source replacement ordering should preserve a valid owner

- Artifact: `execplan.md`
- Evidence: the draft removed legacy files before renaming the prepared
  canonical file. An interruption in that small window could leave no
  repository-owned Google source.
- Why it matters: later unattended apt work would lack the intended Google
  package definitions until the next successful deploy.
- Resolution: fully stage and validate the canonical file, atomically replace
  `chief-google-cloud.list`, then remove competing Google source files. A
  cleanup interruption may leave duplicates, but never removes the canonical
  owner and is repaired on the next run.

---ADVERSARIAL_REVIEW_STATUS---
ISSUES_FOUND: 4
CRITICAL_COUNT: 0
HIGH_COUNT: 2
MEDIUM_COUNT: 2
LOW_COUNT: 0
CONFIDENCE: HIGH
BLOCKING: false
SUMMARY: Four verified plan changes were incorporated before implementation.
---END_ADVERSARIAL_REVIEW_STATUS---
