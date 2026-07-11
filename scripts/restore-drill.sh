#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:?usage: restore-drill.sh IMAGE BACKUP WORKDIR}"
BACKUP="${2:?usage: restore-drill.sh IMAGE BACKUP WORKDIR}"
WORKDIR="${3:?usage: restore-drill.sh IMAGE BACKUP WORKDIR}"
install -d -m 0750 "$WORKDIR"
cp "$BACKUP" "$WORKDIR/drill.db"
docker run --rm --user "$(id -u):$(id -g)" --volume "$WORKDIR:$WORKDIR" \
  "$IMAGE" verify-restore --backup "$WORKDIR/drill.db"
printf '%s\n' 'restore drill passed'
