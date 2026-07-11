# Operations

## Health and logs

Chief exposes `GET /healthz` only at `127.0.0.1:8080`. Readiness covers Discord READY, SQLite read/write plus sqlite-vec, free disk, and maintenance freshness.

```bash
gcloud compute ssh chief --zone="$GCP_ZONE" --tunnel-through-iap \
  --command='curl -fsS http://127.0.0.1:8080/healthz'
gcloud logging read 'resource.type="gce_instance" AND jsonPayload.msg:"chief"' \
  --limit=100 --format=json
```

The Ops Agent collects journald and host metrics. Alerting covers VM uptime and redacted events for process health, backups, budget warning/ceiling, disk pressure, and voice underruns. Logs must never include prompts, messages, transcripts, Discord IDs, provider payloads, or secret values.

## Usage and memory jobs

The SQLite usage ledger is the authoritative local month record. Outstanding reservations remain charged after a crash until reconciled or month rollover. Inspect operational counts without reading private content:

```bash
sudo sqlite3 /var/lib/chief/chief.db \
  'select status, count(*) from memory_jobs group by status;'
sudo sqlite3 /var/lib/chief/chief.db \
  "select round(sum(coalesce(actual_usd,reservation_usd)),4) from usage_ledger where occurred_at >= unixepoch('now','start of month')*1000;"
```

Update model aliases and price environment values when OpenAI pricing changes. A budget-paused extraction job is deferred to the first instant of the next UTC month without consuming an attempt.

## Backup and restore

The nightly timer creates an online SQLite backup, verifies `integrity_check` and `vec_version()`, then uploads it to the thirty-day GCS bucket.

```bash
systemctl status chief-backup.timer
journalctl -u chief-backup.service --since yesterday
gcloud storage ls "gs://$CHIEF_BACKUP_BUCKET/"
```

For a restore, stop Chief, download the selected object, and use the repository script. The script verifies first, atomically swaps the database, preserves the failed copy, and restarts Chief:

```bash
sudo /opt/chief/restore.sh IMAGE@sha256:DIGEST /var/lib/chief/backups/KNOWN.db /var/lib/chief/chief.db
```

Run `scripts/restore-drill.sh` against a scratch directory before relying on a new backup path. A local fake rollback test proves control flow; only an owner-run GCP drill proves actual IAP, disk, bucket, and five-minute recovery behavior.

## Routine changes

- Rotate Discord/OpenAI secrets by adding a new Secret Manager version, then restart `chief.service`.
- Register command definition changes with `pnpm chief -- register-commands` using owner credentials.
- Resize to `e2-small` only after sustained swap, missed Discord heartbeats, or audible latency. Change Terraform, review the plan, and merge normally.
- Retained text expires after 30 days; voice transcripts after 7 days. Audio is never persisted.
- To forget a durable memory, ask Chief naturally. V1 exposes no database browser or admin command.

Do not use `terraform force-unlock` until the owning process or CI run is proven dead. Preserve the lock ID and incident evidence.
