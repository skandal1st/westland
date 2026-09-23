#!/usr/bin/env sh
# AXIMA Compose recovery. See docs/RECOVERY.md.
set -eu
ROOT="$(CDPATH= cd "$(dirname "$0")" && pwd)"
exec node "$ROOT/scripts/backup-restore.mjs" restore "$@"
