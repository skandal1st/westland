#!/bin/sh
# Supported deployment entry point; activation/configuration helper is scripts/install.mjs.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$ROOT/scripts/deploy.mjs" install "$@"
