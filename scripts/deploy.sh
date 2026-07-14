#!/usr/bin/env bash
set -euo pipefail
umask 077

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
RUNTIME_DIR="${CHIEF_RUNTIME_DIR:-/run/chief}"
STATE_FILE="$DATA_DIR/deploy.env"
DATABASE="$DATA_DIR/chief.db"
BACKUP_DIR="$DATA_DIR/pre-deploy"
PREVIOUS_IMAGE=""
BACKUP=""
MIGRATED=false

if [[ -f "$STATE_FILE" ]]; then
  PREVIOUS_IMAGE="$(sed -n 's/^IMAGE=//p' "$STATE_FILE")"
fi

write_state() {
  local image="$1"
  local recovery_image="$2"
  printf 'IMAGE=%s\nRECOVERY_IMAGE=%s\n' "$image" "$recovery_image" \
    >"$STATE_FILE.tmp"
  chmod 0600 "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

prune_recovery_artifacts() {
  if [[ -d "$BACKUP_DIR" ]]; then
    find "$BACKUP_DIR" -type f -name '*.db' -mmin +43199 -delete
  fi
  find "$DATA_DIR" -maxdepth 1 -type f -name 'chief.db.failed.*' \
    -mmin +43199 -delete
}

docker logout "$REGISTRY" >/dev/null 2>&1 || true
install -d -m 0700 "$RUNTIME_DIR"
DOCKER_CONFIG="$(mktemp -d "$RUNTIME_DIR/docker-config.XXXXXX")"
export DOCKER_CONFIG
cleanup() {
  rm -rf "$DOCKER_CONFIG"
}
trap cleanup EXIT
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
  if [[ "$MIGRATED" == true ]]; then
    failed_database="$DATABASE.failed.$(date -u +%Y%m%dT%H%M%SZ)"
    if [[ -f "$DATABASE" ]]; then
      mv "$DATABASE" "$failed_database"
      chmod 0600 "$failed_database"
    fi
    rm -f "$DATABASE-wal" "$DATABASE-shm"
    if [[ -n "$BACKUP" ]]; then
      install -m 0600 "$BACKUP" "$DATABASE.restore"
      mv "$DATABASE.restore" "$DATABASE"
      chown "$DATA_UID:$DATA_GID" "$DATABASE"
    fi
  fi
  if [[ -n "$PREVIOUS_IMAGE" ]]; then
    write_state "$PREVIOUS_IMAGE" "$CANDIDATE_IMAGE"
    prune_recovery_artifacts
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
docker run --rm --user "$DATA_UID:$DATA_GID" \
  --volume "$DATA_DIR:$DATA_DIR" \
  "$CANDIDATE_IMAGE" verify-restore --backup "$DATABASE" \
  --require-migration 0003_channel_context
write_state "$CANDIDATE_IMAGE" "$CANDIDATE_IMAGE"
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
cleanup_ready=true
if [[ -n "$PREVIOUS_IMAGE" && "$PREVIOUS_IMAGE" != "$CANDIDATE_IMAGE" ]]; then
  if ! docker image tag "$PREVIOUS_IMAGE" chief:rollback; then
    printf '%s\n' \
      '{"msg":"chief_image_cleanup_failed","stage":"rollback_tag"}' >&2
    cleanup_ready=false
  fi
fi
if [[ "$cleanup_ready" == true ]]; then
  if ! docker image prune --force; then
    printf '%s\n' \
      '{"msg":"chief_image_cleanup_failed","stage":"prune"}' >&2
  fi
fi
prune_recovery_artifacts
printf '{"msg":"chief_deploy_succeeded","image":"%s"}\n' "$CANDIDATE_IMAGE"
