#!/usr/bin/env bash
set -euo pipefail

# These environment files are provisioned on the VM before this script runs.
# shellcheck disable=SC1091
source /etc/chief/chief.env
# shellcheck disable=SC1091
source /var/lib/chief/deploy.env
install -d -m 0700 /run/chief
umask 077
DISCORD_TOKEN="$(gcloud secrets versions access latest --project="$GCP_PROJECT_ID" --secret=chief-discord-token)"
OPENAI_API_KEY="$(gcloud secrets versions access latest --project="$GCP_PROJECT_ID" --secret=chief-openai-api-key)"
{
  cat /etc/chief/chief.env
  printf 'DISCORD_TOKEN=%s\n' "$DISCORD_TOKEN"
  printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY"
} >/run/chief/runtime.env
docker rm --force chief >/dev/null 2>&1 || true
exec docker run --name chief \
  --env-file /run/chief/runtime.env \
  --publish 127.0.0.1:8080:8080 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --volume /var/lib/chief:/var/lib/chief \
  "$IMAGE"
