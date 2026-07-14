#!/usr/bin/env bash
set -euo pipefail

SOURCES_DIR="${GOOGLE_CLOUD_APT_SOURCES_DIR:-/etc/apt/sources.list.d}"
KEYRING="${GOOGLE_CLOUD_APT_KEYRING:-/usr/share/keyrings/google-cloud.gpg}"
CANONICAL_SOURCE="$SOURCES_DIR/chief-google-cloud.list"
REPOSITORY_URL="https://packages.cloud.google.com/apt"

if [[ ! -s "$KEYRING" ]]; then
  echo "Google Cloud apt keyring is missing or empty" >&2
  exit 1
fi

install -d -m 0755 "$SOURCES_DIR"
temporary_source="$(mktemp "$SOURCES_DIR/.chief-google-cloud.list.XXXXXX")"
cleanup() {
  rm -f "$temporary_source"
}
trap cleanup EXIT

cat >"$temporary_source" <<EOF
deb [signed-by=$KEYRING] $REPOSITORY_URL google-compute-engine-bookworm-stable main
deb [signed-by=$KEYRING] $REPOSITORY_URL cloud-sdk-bookworm main
deb [signed-by=$KEYRING] $REPOSITORY_URL google-cloud-packages-archive-keyring-bookworm-stable main
deb [signed-by=$KEYRING] $REPOSITORY_URL google-cloud-ops-agent-bookworm-all main
EOF
valid_source=true
for suite in \
  google-compute-engine-bookworm-stable \
  cloud-sdk-bookworm \
  google-cloud-packages-archive-keyring-bookworm-stable \
  google-cloud-ops-agent-bookworm-all; do
  if ! grep -Fqx \
    "deb [signed-by=$KEYRING] $REPOSITORY_URL $suite main" \
    "$temporary_source"; then
    valid_source=false
  fi
done
if [[ "$(grep -c '^' "$temporary_source")" -ne 4 || "$valid_source" != true ]]; then
  echo "Generated Google Cloud apt source is invalid" >&2
  exit 1
fi
chmod 0644 "$temporary_source"
mv -f "$temporary_source" "$CANONICAL_SOURCE"

shopt -s nullglob
for source in "$SOURCES_DIR"/*.list "$SOURCES_DIR"/*.sources; do
  [[ "$source" == "$CANONICAL_SOURCE" ]] && continue
  case "${source##*/}" in
    google_osconfig_managed.*) continue ;;
  esac
  if grep -Fq 'packages.cloud.google.com/apt' "$source"; then
    rm -f "$source"
  fi
done

trap - EXIT
