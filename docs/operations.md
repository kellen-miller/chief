# Operations

## Health and logs

Chief exposes `GET /healthz` only at `127.0.0.1:8080`. The response separates
`criticalChecks` from `diagnostics`. Only database/SQLite-vector access, Discord
READY, free disk, and maintenance freshness determine `ready` and HTTP 200/503.
Ordinary context lag is diagnostic-only, so a stale index does not disconnect
Discord. The host-side forget-journal recovery gate is different: it fails
closed before Discord connects if journals cannot be listed, read, verified, or
replayed.

```bash
gcloud compute ssh chief --zone="$GCP_ZONE" --tunnel-through-iap \
  --command='curl -fsS http://127.0.0.1:8080/healthz'
gcloud logging read 'resource.type="gce_instance" AND jsonPayload.msg:"chief"' \
  --limit=100 --format=json
```

The Ops Agent collects journald and host metrics. Alerting covers VM uptime and redacted events for process health, backups, budget warning/ceiling, disk pressure, and voice underruns. Logs must never include prompts, messages, transcripts, Discord IDs, provider payloads, or secret values.

`diagnostics.context` is content-free. It reports `degraded`, per-tier age in
seconds, reconciliation age, pending/failed job counts, active/paused/failed
backfill counts, and one bounded reason: `provider`, `overall-budget`,
`indexing-budget`, `run-budget`, or `backlog`. It never includes source IDs,
speaker IDs, topics, summaries, prompts, or provider errors.

## Usage and memory jobs

The SQLite usage ledger is the authoritative local month record. Outstanding reservations remain charged after a crash until reconciled or month rollover. Inspect operational counts without reading private content:

```bash
sudo sqlite3 /var/lib/chief/chief.db \
  'select status, count(*) from memory_jobs group by status;'
sudo sqlite3 /var/lib/chief/chief.db \
  'select medium, role, count(*) from conversation_events group by medium, role;'
sudo sqlite3 /var/lib/chief/chief.db \
  "select count(*) from conversation_events where retention_deadline <= unixepoch('now')*1000;"
sudo sqlite3 /var/lib/chief/chief.db \
  "select round(sum(coalesce(actual_usd,reservation_usd)),4) from usage_ledger where occurred_at >= unixepoch('now','start of month')*1000;"
sudo sqlite3 /var/lib/chief/chief.db \
  'select tier, status, count(*) from context_jobs group by tier, status;'
sudo sqlite3 /var/lib/chief/chief.db \
  'select status, count(*) from context_backfills group by status;'
sudo sqlite3 /var/lib/chief/chief.db \
  "select work_category, round(sum(coalesce(actual_usd,reservation_usd)),4) from usage_ledger where occurred_at >= unixepoch('now','start of month')*1000 group by work_category;"
```

Update model aliases and price environment values when OpenAI pricing changes. A budget-paused extraction job is deferred to the first instant of the next UTC month without consuming an attempt.

Chief runs retention maintenance once during startup and every twenty-four hours
thereafter. Recent text, voice, and Chief replies share a seven-day timeline.
Eligible raw text and hourly context remain for 30 days, daily rollups for one
year, and weekly/long-term rollups until explicit deletion. Raw voice remains
seven days and is not ambiently indexed. Durable memories do not expire with the
conversation timeline. After raw evidence expires, surviving rollups are
summary-only: they support cautious historical recap, not quotations or proof of
exact wording. Explicit memory/context telemetry contains only outcome and
aggregate state.

Under provider availability and applicable budget capacity, an active hour gets
provisional semantic context within five minutes. Final hourly work targets ten
minutes after close, daily work thirty minutes, weekly work two hours, and
long-term topic work one day. Deferred work catches up in deadline order. The
overall monthly ceiling remains authoritative; the USD 3 indexing sub-ceiling
and an owner-approved per-backfill ceiling can pause only background work.

## Historical backfill

The owner first records a content-free inventory. The CLI persists page
boundaries and aggregate counts, never historical message text:

```bash
pnpm chief -- context-backfill --dry-run
pnpm chief -- context-backfill --activate --confirm-guild "$DISCORD_GUILD_ID" --max-usd 1.00
pnpm chief -- context-backfill --status
pnpm chief -- context-backfill --resume RUN_ID
```

Activation performs no paid call. The running Chief process executes the work
oldest-first through the normal protected queue and prints no private content.
An interrupted or budget-paused run resumes from its durable content-free
manifest. Do not activate until the dry-run count and estimate have been
reviewed and an explicit maximum spend is approved.

## Backup and restore

The nightly timer creates an online SQLite backup mode 0600, verifies migration
checksums, `integrity_check`, sqlite-vec, and context FTS/vector consistency,
then uploads it below `backups/`. Legacy root `.db` objects and new backup
objects become deletion-eligible at age 30. Content-free `forget-journal/`
objects and their noncurrent versions remain for at least 60 days. GCS lifecycle
enforcement is asynchronous.

```bash
systemctl status chief-backup.timer
journalctl -u chief-backup.service --since yesterday
gcloud storage ls "gs://$CHIEF_BACKUP_BUCKET/backups/"
gcloud storage ls "gs://$CHIEF_BACKUP_BUCKET/forget-journal/"
```

Inspect a downloaded current backup without migrating it:

```bash
pnpm chief -- verify-restore --backup ./chief.db --require-migration 0003_channel_context
```

Without `--require-migration`, verification accepts a compatible recorded
migration prefix (including migration 0002) only when every recorded checksum
matches. Explicit 0003 mode also requires the exact active public document IDs
in FTS and vectors, exact FTS token positions for every summary, a joined
hourly/daily/weekly/long-term query, tombstone checksums, and retained backfill
progress. Count parity alone does not pass.

For a restore, stop Chief, download the selected object, and use the repository
script. The script verifies with the retained recovery image, atomically swaps
the database, preserves the failed copy mode 0600 for no more than 30 days, and
updates the target image while retaining `RECOVERY_IMAGE`. Before stopping the
service it also compares the backup's verified database capability with the
immutable target-image capability label. A current-schema database is refused
for an older or unlabeled target image:

```bash
sudo /opt/chief/restore.sh IMAGE@sha256:DIGEST /var/lib/chief/backups/KNOWN.db /var/lib/chief/chief.db
```

Run `scripts/restore-drill.sh` against a scratch directory before relying on a new backup path. A local fake rollback test proves control flow; only an owner-run GCP drill proves actual IAP, disk, bucket, and five-minute recovery behavior.

`deploy.env` contains both `IMAGE` and `RECOVERY_IMAGE`. A normal deploy sets
both to the capable candidate. Rollback restores the matching pre-migration
database and previous `IMAGE` together while retaining the candidate recovery
digest. Every systemd start lists current and noncurrent journal generations,
downloads every object by its generation-qualified GCS URL into a distinct
file, and records each generation plus checksum in its mode-0600 receipt. It
then replays them idempotently through `RECOVERY_IMAGE`, verifies the database,
checks the target-image capability, and only then reads secrets and starts
`IMAGE`. An older image remains valid only with its compatible pre-migration
database. Never bypass `/opt/chief/run-container.sh` after replacing a file.

Local `pre-deploy/*.db`, `chief.db.failed.*`, and bucket backups are encrypted at
rest but can contain logically plaintext bytes forgotten after they were
created. Active SQLite, FTS, and vector state is purged before acknowledgement;
new backups exclude it. Older recovery artifacts remain a bounded accepted risk
until deletion-eligible at 30 days, while the longer-lived content-free journal
prevents supported recovery from resurrecting it. Successful deploy, restore,
and every startup prune local artifacts at that boundary.

## Deployment housekeeping

After a candidate passes readiness, the deployment tags the previously running
digest as `chief:rollback` and runs a dangling-image prune. The active container
protects the current digest and the tag protects one local rollback image; older
Chief release images are reclaimed. Tagging and pruning are post-success,
best-effort housekeeping. A failure emits a redacted
`chief_image_cleanup_failed` warning to stderr but does not roll back a healthy
candidate. If rollback tagging fails, pruning is skipped to preserve the prior
digest.

Inspect local retention and disk use with:

```bash
sudo docker image inspect chief:rollback --format '{{json .RepoDigests}}'
sudo docker image ls --all --digests
sudo docker system df
```

Do not use `docker image prune --all`: it broadens cleanup beyond dangling
images and can remove the tagged rollback image. Artifact Registry retention is
unchanged. The local tag is an operational convenience, not a replacement for
the paired pre-deploy database backup required by rollback.

Chief owns `/etc/apt/sources.list.d/chief-google-cloud.list`. The repository
script `/opt/chief/configure-google-cloud-apt.sh` converges the Debian 12 Compute
Engine, Cloud SDK, package-keyring, and Ops Agent suites on one signing key. It
removes competing Google package definitions by repository URL while preserving
`google_osconfig_managed.*`. Startup runs it before package installation and
ordinary deployments run it before changing the Chief process, so a repair
failure leaves the existing application available and fails the deployment.

## Routine changes

- Rotate Discord/OpenAI secrets by adding a new Secret Manager version, then restart `chief.service`.
- Register command definition changes with `pnpm chief -- register-commands` using owner credentials.
- Resize to `e2-small` only after sustained swap, missed Discord heartbeats, or audible latency. Change Terraform, review the plan, and merge normally.
- Recent text and voice conversation expires after 7 days. Raw indexed text and hourly context expire after 30 days, daily context after one year, and raw voice after 7 days. Audio is never persisted.
- To forget memory or historical context, ask Chief naturally. A successful acknowledgement states that active/searchable state is gone and older encrypted recovery bytes can remain for at most 30 days. Discord source messages are not deleted.

Do not use `terraform force-unlock` until the owning process or CI run is proven dead. Preserve the lock ID and incident evidence.
