#!/usr/bin/env bash
set -euo pipefail

CANDIDATE_IMAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) CANDIDATE_IMAGE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ ! "$CANDIDATE_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "--image must be an immutable sha256 digest" >&2
  exit 2
fi
REGISTRY="${CANDIDATE_IMAGE%%/*}"

DATA_DIR="${CHIEF_DATA_DIR:-/var/lib/chief}"
DATA_UID="${CHIEF_DATA_UID:-1000}"
DATA_GID="${CHIEF_DATA_GID:-1000}"
STATE_FILE="$DATA_DIR/deploy.env"
DATABASE="$DATA_DIR/chief.db"
BACKUP_DIR="$DATA_DIR/pre-deploy"
PREVIOUS_IMAGE=""
BACKUP=""
MIGRATED=false

if [[ -f "$STATE_FILE" ]]; then
  PREVIOUS_IMAGE="$(sed -n 's/^IMAGE=//p' "$STATE_FILE")"
fi

gcloud auth print-access-token \
  | docker login --username oauth2accesstoken --password-stdin "$REGISTRY"
docker pull "$CANDIDATE_IMAGE"
systemctl stop chief.service || true
docker stop --time 20 chief >/dev/null 2>&1 || true

if [[ -f "$DATABASE" ]]; then
  BACKUP="$(docker run --rm \
    --user "$DATA_UID:$DATA_GID" \
    --volume "$DATA_DIR:$DATA_DIR" \
    "$CANDIDATE_IMAGE" backup --database "$DATABASE" --destination "$BACKUP_DIR")"
  docker run --rm --user "$DATA_UID:$DATA_GID" \
    --volume "$DATA_DIR:$DATA_DIR" \
    "$CANDIDATE_IMAGE" verify-restore --backup "$BACKUP"
fi

rollback() {
  local failed_database
  systemctl stop chief.service || true
  docker stop --time 5 chief >/dev/null 2>&1 || true
  if [[ "$MIGRATED" == true && -n "$BACKUP" ]]; then
    failed_database="$DATABASE.failed.$(date -u +%Y%m%dT%H%M%SZ)"
    [[ -f "$DATABASE" ]] && mv "$DATABASE" "$failed_database"
    cp "$BACKUP" "$DATABASE.restore"
    mv "$DATABASE.restore" "$DATABASE"
    chown "$DATA_UID:$DATA_GID" "$DATABASE"
    rm -f "$DATABASE-wal" "$DATABASE-shm"
  fi
  if [[ -n "$PREVIOUS_IMAGE" ]]; then
    printf 'IMAGE=%s\n' "$PREVIOUS_IMAGE" >"$STATE_FILE.tmp"
    mv "$STATE_FILE.tmp" "$STATE_FILE"
    systemctl start chief.service
    for _ in $(seq 1 60); do
      curl --fail --silent --max-time 3 http://127.0.0.1:8080/healthz >/dev/null && return 0
      sleep 2
    done
  fi
  return 1
}
on_error() {
  local status=$?
  trap - ERR
  rollback || true
  exit "$status"
}
trap on_error ERR

docker run --rm --user "$DATA_UID:$DATA_GID" \
  --volume "$DATA_DIR:$DATA_DIR" \
  "$CANDIDATE_IMAGE" migrate --database "$DATABASE"
MIGRATED=true
printf 'IMAGE=%s\n' "$CANDIDATE_IMAGE" >"$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
systemctl start chief.service

healthy=false
for _ in $(seq 1 150); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8080/healthz >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  echo "candidate failed readiness; rolling back" >&2
  false
fi

trap - ERR
printf '{"msg":"chief_deploy_succeeded","image":"%s"}\n' "$CANDIDATE_IMAGE"
