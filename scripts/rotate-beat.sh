#!/usr/bin/env bash
# Manual/admin fallback for ballot rotate. Primary scheduler is
# Cloudflare Workers Cron Triggers on ballot-api (*/1 * * * *; not crontab, not Grok Bot).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec python3 "$ROOT/scripts/rotate-beat.py" "$@"
