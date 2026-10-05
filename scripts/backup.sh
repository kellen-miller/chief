#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${CHIEF_OPS_NODE:-node}" "$SCRIPT_DIR/../src/ops/cli.ts" backup "$@"
