#!/usr/bin/env bash
set -euo pipefail
umask 077

# These environment files are provisioned on the VM before this script runs.
CONFIG_FILE="${CHIEF_CONFIG_FILE:-/etc/chief/chief.env}"
DEPLOY_STATE_FILE="${CHIEF_DEPLOY_STATE_FILE:-/var/lib/chief/deploy.env}"
# shellcheck disable=SC1091
source "$CONFIG_FILE"
# shellcheck disable=SC1091
source "$DEPLOY_STATE_FILE"
DATA_DIR="${CHIEF_DATA_DIR:-/var/lib/chief}"
DATA_UID="${CHIEF_DATA_UID:-1000}"
DATA_GID="${CHIEF_DATA_GID:-1000}"
RUNTIME_DIR="${CHIEF_RUNTIME_DIR:-/run/chief}"
DATABASE="$DATA_DIR/chief.db"
RECEIPT="$DATA_DIR/.forget-journal-replay.receipt"
JOURNAL_DIR="$RUNTIME_DIR/forget-journal"

if [[ ! "${IMAGE:-}" =~ @sha256:[0-9a-f]{64}$ ]] ||
   [[ ! "${RECOVERY_IMAGE:-}" =~ @sha256:[0-9a-f]{64}$ ]]; then
  logger -t chief '{"msg":"chief_recovery_failed","reason":"image_state"}'
  exit 1
fi

prune_recovery_artifacts() {
  if [[ -d "$DATA_DIR/pre-deploy" ]]; then
    find "$DATA_DIR/pre-deploy" -type f -name '*.db' -mmin +43199 -delete
  fi
  find "$DATA_DIR" -maxdepth 1 -type f -name 'chief.db.failed.*' \
    -mmin +43199 -delete
}

recovery_failure() {
  logger -t chief \
    "{\"msg\":\"chief_recovery_failed\",\"reason\":\"$1\"}"
  exit 1
}

database_checksum() {
  {
    for path in "$DATABASE" "$DATABASE-wal" "$DATABASE-shm"; do
      [[ -f "$path" ]] && sha256sum "$path"
    done
    true
  } | sha256sum | awk '{print $1}'
}

manifest_checksum() {
  while IFS= read -r path; do
    sha256sum "$path"
  done < <(find "$JOURNAL_DIR" -type f -name '*.json' | LC_ALL=C sort)
}

prune_recovery_artifacts
rm -rf "$JOURNAL_DIR"
install -d -o "$DATA_UID" -g "$DATA_GID" -m 0700 "$JOURNAL_DIR"
GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(
  curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 \
    --header 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/project/project-id
)}"

OBJECT_LIST="$RUNTIME_DIR/forget-journal.objects"
ALL_OBJECTS="$RUNTIME_DIR/bucket.objects"
if ! gcloud storage ls --recursive \
  "gs://$CHIEF_BACKUP_BUCKET/" >"$ALL_OBJECTS"; then
  recovery_failure journal_list
fi
: >"$OBJECT_LIST"
while IFS= read -r object; do
  if [[ "$object" == "gs://$CHIEF_BACKUP_BUCKET/forget-journal/"* ]]; then
    printf '%s\n' "$object" >>"$OBJECT_LIST"
  fi
done <"$ALL_OBJECTS"
while IFS= read -r object; do
  [[ -z "$object" ]] && continue
  if [[ ! "$object" =~ ^gs://[^/]+/forget-journal/[^/]+\.json$ ]]; then
    recovery_failure journal_manifest
  fi
  destination="$JOURNAL_DIR/${object##*/}"
  if ! gcloud storage cp "$object" "$destination"; then
    recovery_failure journal_read
  fi
  chown "$DATA_UID:$DATA_GID" "$destination"
  chmod 0600 "$destination"
done <"$OBJECT_LIST"

DATABASE_CHECKSUM="$(database_checksum)"
MANIFEST_CHECKSUM="$(manifest_checksum | sha256sum | awk '{print $1}')"
EXPECTED_RECEIPT="database=$DATABASE_CHECKSUM
manifest=$MANIFEST_CHECKSUM"
if [[ ! -f "$RECEIPT" ]] || [[ "$(cat "$RECEIPT")" != "$EXPECTED_RECEIPT" ]]; then
  if ! docker run --rm --user "$DATA_UID:$DATA_GID" \
    --volume "$DATA_DIR:$DATA_DIR" \
    --volume "$JOURNAL_DIR:/run/chief/forget-journal:ro" \
    "$RECOVERY_IMAGE" recover-forget-journals \
      --database "$DATABASE" \
      --journal-directory /run/chief/forget-journal; then
    recovery_failure journal_replay
  fi
  DATABASE_CHECKSUM="$(database_checksum)"
  printf 'database=%s\nmanifest=%s\n' \
    "$DATABASE_CHECKSUM" "$MANIFEST_CHECKSUM" >"$RECEIPT.tmp"
  chown "$DATA_UID:$DATA_GID" "$RECEIPT.tmp"
  chmod 0600 "$RECEIPT.tmp"
  mv "$RECEIPT.tmp" "$RECEIPT"
fi

DISCORD_TOKEN="$(gcloud secrets versions access latest --project="$GCP_PROJECT_ID" --secret=chief-discord-token)"
OPENAI_API_KEY="$(gcloud secrets versions access latest --project="$GCP_PROJECT_ID" --secret=chief-openai-api-key)"
{
  cat "$CONFIG_FILE"
  printf 'DISCORD_TOKEN=%s\n' "$DISCORD_TOKEN"
  printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY"
} >"$RUNTIME_DIR/runtime.env"
docker rm --force chief >/dev/null 2>&1 || true
exec docker run --name chief \
  --env-file "$RUNTIME_DIR/runtime.env" \
  --publish 127.0.0.1:8080:8080 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --volume /var/lib/chief:/var/lib/chief \
  "$IMAGE"
