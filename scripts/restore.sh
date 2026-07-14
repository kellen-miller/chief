#!/usr/bin/env bash
set -euo pipefail
umask 077

IMAGE="${1:?usage: restore.sh IMAGE BACKUP DATABASE}"
BACKUP="${2:?usage: restore.sh IMAGE BACKUP DATABASE}"
DATABASE="${3:?usage: restore.sh IMAGE BACKUP DATABASE}"
DATA_DIR="$(dirname "$DATABASE")"
STATE_FILE="$DATA_DIR/deploy.env"
DATA_UID="${CHIEF_DATA_UID:-1000}"
DATA_GID="${CHIEF_DATA_GID:-1000}"
RECOVERY_IMAGE="$(sed -n 's/^RECOVERY_IMAGE=//p' "$STATE_FILE")"
if [[ ! "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] ||
   [[ ! "$RECOVERY_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo 'restore requires immutable target and recovery images' >&2
  exit 2
fi
docker run --rm --user "$DATA_UID:$DATA_GID" --volume "$DATA_DIR:$DATA_DIR" \
  "$RECOVERY_IMAGE" verify-restore --backup "$BACKUP"
systemctl stop chief.service
if [[ -f "$DATABASE" ]]; then
  FAILED_DATABASE="$DATABASE.failed.$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$DATABASE" "$FAILED_DATABASE"
  chmod 0600 "$FAILED_DATABASE"
fi
install -m 0600 "$BACKUP" "$DATABASE.restore"
mv "$DATABASE.restore" "$DATABASE"
chown "$DATA_UID:$DATA_GID" "$DATABASE"
rm -f "$DATABASE-wal" "$DATABASE-shm"
printf 'IMAGE=%s\nRECOVERY_IMAGE=%s\n' "$IMAGE" "$RECOVERY_IMAGE" \
  >"$STATE_FILE.tmp"
chmod 0600 "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
if [[ -d "$DATA_DIR/pre-deploy" ]]; then
  find "$DATA_DIR/pre-deploy" -type f -name '*.db' -mmin +43199 -delete
fi
find "$DATA_DIR" -maxdepth 1 -type f -name 'chief.db.failed.*' \
  -mmin +43199 -delete
systemctl start chief.service
