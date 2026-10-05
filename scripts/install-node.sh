#!/usr/bin/env bash
set -euo pipefail
# Pinned host runtime for native TypeScript; no npm dependencies on the VM.
VERSION=24.21.0
SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
if [[ -x /opt/chief/node/bin/node ]] && [[ "$(/opt/chief/node/bin/node --version)" == "v$VERSION" ]]; then exit 0; fi
command -v xz >/dev/null || apt-get install --yes --no-install-recommends xz-utils
TEMPORARY="$(mktemp -d)"
trap 'rm -rf "$TEMPORARY"' EXIT
curl --fail --silent --show-error --max-time 120 \
  "https://nodejs.org/dist/v$VERSION/node-v$VERSION-linux-x64.tar.xz" -o "$TEMPORARY/node.tar.xz"
printf '%s  %s\n' "$SHA256" "$TEMPORARY/node.tar.xz" | sha256sum --check --status
install -d -m 0755 /opt/chief
# Install from the verified archive before replacing the previous runtime.
tar -xJf "$TEMPORARY/node.tar.xz" -C "$TEMPORARY"
rm -rf /opt/chief/node
mv "$TEMPORARY/node-v$VERSION-linux-x64" /opt/chief/node
