#!/usr/bin/env bash
set -euo pipefail
umask 077

IMAGE="${1:?usage: restore-drill.sh IMAGE BACKUP WORKDIR}"
BACKUP="${2:?usage: restore-drill.sh IMAGE BACKUP WORKDIR}"
WORKDIR="${3:?usage: restore-drill.sh IMAGE BACKUP WORKDIR}"
install -d -m 0700 "$WORKDIR"
install -m 0600 "$BACKUP" "$WORKDIR/drill.db"
docker run --rm --user "$(id -u):$(id -g)" --volume "$WORKDIR:$WORKDIR" \
  "$IMAGE" verify-restore --backup "$WORKDIR/drill.db" \
  --require-migration 0003_channel_context
printf '%s\n' 'restore drill passed'
