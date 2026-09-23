#!/usr/bin/env sh
# Strict entry point. Local checks cannot substitute for R37/R39 deployment acceptance.
set -eu
ROOT="$(CDPATH= cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node scripts/release-checks.mjs --acceptance "$@"
