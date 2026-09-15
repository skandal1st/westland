#!/usr/bin/env sh
# AXIMA Commerce update (M10).
#
# Health-gated, rollback-capable update:
#   1. record the current image (rollback point) and verify current health
#   2. pull the new source/image and rebuild
#   3. apply forward migrations (prisma migrate deploy — never db push)
#   4. restart the app and re-check health
#   5. on failure, roll the APP back to the previous image (DB migrations are
#      forward-only; restore.sh + a DB backup is the path for a data rollback)
#
# App↔migration compatibility: migrations are additive and deploy-only, so a
# newer app runs older data and a rolled-back app tolerates already-applied
# additive migrations. Take a backup.sh snapshot before a destructive change.
#
# Usage: ./update.sh [--no-pull]
set -eu

DEPLOY_DIR="deployment"
ENV_FILE="$DEPLOY_DIR/secrets/.env"
PULL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) PULL=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no deployment secrets at $ENV_FILE — run install.sh first"

wait_healthy() { # wait_healthy SERVICE
  i=0; while [ "$i" -lt 30 ]; do
    s=$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q "$1")" 2>/dev/null || echo "")
    [ "$s" = "healthy" ] && return 0
    i=$((i+1)); sleep 2
  done
  return 1
}

PREVIOUS_IMAGE="$(docker compose --env-file "$ENV_FILE" images -q app 2>/dev/null || echo "")"
log "Rollback point (current app image): ${PREVIOUS_IMAGE:-none}"

if [ "$PULL" = "1" ]; then
  log "Pulling latest source..."
  if [ -d .git ]; then git pull --ff-only || die "git pull failed"; fi
fi

log "Building new application image..."
docker compose --env-file "$ENV_FILE" build app

log "Ensuring database is up..."
docker compose --env-file "$ENV_FILE" up -d postgres
wait_healthy postgres || die "database did not become healthy"

log "Applying forward migrations..."
docker compose --env-file "$ENV_FILE" run --rm \
  -v "$(pwd)/$DEPLOY_DIR:/app/deployment" \
  app sh -c "node_modules/.bin/prisma migrate deploy" || die "migration failed — aborting before restart"

log "Restarting application..."
docker compose --env-file "$ENV_FILE" --profile full up -d app

if wait_healthy app; then
  log "Update complete; app is healthy."
else
  log "New app is UNHEALTHY — rolling back."
  if [ -n "$PREVIOUS_IMAGE" ]; then
    docker tag "$PREVIOUS_IMAGE" "$(docker compose --env-file "$ENV_FILE" config --images | grep -m1 app || echo axima-app)" 2>/dev/null || true
    docker compose --env-file "$ENV_FILE" --profile full up -d app
    wait_healthy app && log "Rolled back to previous app image." || die "rollback failed — investigate; DB is intact (use restore.sh with a backup if needed)"
  else
    die "no previous image to roll back to — investigate; DB is intact"
  fi
fi
