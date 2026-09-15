#!/usr/bin/env bash
# Cloud-computer cron entrypoint (not Grok Bot). Requires python3, git; curl via stdlib.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec python3 "$ROOT/scripts/rotate-beat.py" "$@"
