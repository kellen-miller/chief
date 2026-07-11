#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:?usage: backup.sh IMAGE DATABASE DESTINATION}"
DATABASE="${2:?usage: backup.sh IMAGE DATABASE DESTINATION}"
DESTINATION="${3:?usage: backup.sh IMAGE DATABASE DESTINATION}"
docker run --rm --volume "$(dirname "$DATABASE"):$(dirname "$DATABASE")" \
  "$IMAGE" backup --database "$DATABASE" --destination "$DESTINATION"
