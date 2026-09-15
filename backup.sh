#!/usr/bin/env sh
# AXIMA Commerce backup (M10).
#
# Captures everything needed to restore or re-home a deployment:
#   - the PostgreSQL database (pg_dump, custom format)
#   - deployment secrets (.env, installation identity private key)
#   - deployment config (store profile, license grant, publisher key)
#   - media uploads (public/uploads, if present)
#
# The installation identity is included so a restore can REACTIVATE against the
# same license seat rather than consuming a new one. Backups are written 0600.
#
# Usage: ./backup.sh [--out DIR]
set -eu

DEPLOY_DIR="deployment"
ENV_FILE="$DEPLOY_DIR/secrets/.env"
OUT_DIR="backups"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no deployment secrets at $ENV_FILE — run install.sh first"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

log "Dumping database..."
# pg_dump inside the postgres container; custom format is compressed + selective.
docker compose --env-file "$ENV_FILE" exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$WORK/database.dump"

log "Collecting config, secrets and media..."
mkdir -p "$WORK/deployment"
cp -a "$DEPLOY_DIR/config" "$WORK/deployment/config" 2>/dev/null || true
cp -a "$DEPLOY_DIR/secrets" "$WORK/deployment/secrets" 2>/dev/null || true
[ -d public/uploads ] && cp -a public/uploads "$WORK/uploads" || true

ARCHIVE="$OUT_DIR/axima-backup-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" .
chmod 600 "$ARCHIVE"
log "Backup written to $ARCHIVE"
