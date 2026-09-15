#!/usr/bin/env sh
# AXIMA Commerce restore (M10).
#
# Restores a backup produced by backup.sh: database + deployment secrets/config
# + media. After restore the installation identity is present again, so the
# license can be REACTIVATED (re-read) without consuming a new seat — the app's
# backoffice "Перечитать лицензию" (or a restart) picks up the restored grant.
#
# Destructive: this OVERWRITES the target database. Refuses to run without
# --confirm so it cannot be triggered by accident.
#
# Usage: ./restore.sh --archive backups/axima-backup-*.tar.gz --confirm
set -eu

DEPLOY_DIR="deployment"
ENV_FILE="$DEPLOY_DIR/secrets/.env"
ARCHIVE=""
CONFIRM=0

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift ;;
    --confirm) CONFIRM=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$ARCHIVE" ] || die "specify --archive PATH"
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
[ "$CONFIRM" = "1" ] || die "refusing to overwrite the database without --confirm"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$ARCHIVE" -C "$WORK"
[ -f "$WORK/database.dump" ] || die "archive missing database.dump"

log "Restoring deployment config and secrets..."
[ -d "$WORK/deployment/config" ] && { mkdir -p "$DEPLOY_DIR"; cp -a "$WORK/deployment/config" "$DEPLOY_DIR/config"; }
[ -d "$WORK/deployment/secrets" ] && cp -a "$WORK/deployment/secrets" "$DEPLOY_DIR/secrets"
[ -d "$WORK/uploads" ] && { mkdir -p public; cp -a "$WORK/uploads" public/uploads; }

[ -f "$ENV_FILE" ] || die "restored secrets missing $ENV_FILE"

log "Starting database..."
docker compose --env-file "$ENV_FILE" up -d postgres
i=0; while [ "$i" -lt 30 ]; do
  s=$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null || echo "")
  [ "$s" = "healthy" ] && break
  i=$((i+1)); sleep 2
done
[ "$s" = "healthy" ] || die "database did not become healthy"

log "Restoring database (overwrite)..."
docker compose --env-file "$ENV_FILE" exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$WORK/database.dump"

log "Restore complete. Restart the app (or use backoffice → Лицензия → Перечитать) to reactivate the license."
