#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:?usage: restore.sh IMAGE BACKUP DATABASE}"
BACKUP="${2:?usage: restore.sh IMAGE BACKUP DATABASE}"
DATABASE="${3:?usage: restore.sh IMAGE BACKUP DATABASE}"
DATA_DIR="$(dirname "$DATABASE")"
DATA_UID="${CHIEF_DATA_UID:-1000}"
DATA_GID="${CHIEF_DATA_GID:-1000}"
docker run --rm --user "$DATA_UID:$DATA_GID" --volume "$DATA_DIR:$DATA_DIR" \
  "$IMAGE" verify-restore --backup "$BACKUP"
systemctl stop chief.service
[[ -f "$DATABASE" ]] && mv "$DATABASE" "$DATABASE.failed.$(date -u +%Y%m%dT%H%M%SZ)"
cp "$BACKUP" "$DATABASE.restore"
mv "$DATABASE.restore" "$DATABASE"
chown "$DATA_UID:$DATA_GID" "$DATABASE"
rm -f "$DATABASE-wal" "$DATABASE-shm"
systemctl start chief.service
