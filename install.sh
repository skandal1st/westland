#!/usr/bin/env sh
# AXIMA Commerce installer (M1 — fresh install foundation).
#
# Idempotent as far as is reasonable: re-running never regenerates secrets,
# never resets an existing profile, never creates a second admin and never
# drops the database. Update / backup / restore / rollback and license
# ENFORCEMENT are hardened in M10; this establishes the deployment foundation.
#
# Usage:
#   ./install.sh [--plan] [--non-interactive] \
#     [--domain shop.example.com] [--store-code westside] [--store-name "Westside"] \
#     [--admin-email admin@example.com] [--modules commerce-core,commerce-b2b,content,invoices] \
#     [--provider one-c|moysklad|custom]
#
#   --plan   Print what would happen and exit. No environment checks, no writes.
#
# Secrets (POSTGRES_PASSWORD, NEXTAUTH_SECRET) are generated if absent and
# stored only under deployment/ with 0600 perms. ADMIN_PASSWORD is generated and
# shown once at the end unless supplied via the ADMIN_PASSWORD environment var.
set -eu

# --- defaults ---------------------------------------------------------------
PLAN=0
INTERACTIVE=1
DOMAIN="${DOMAIN:-}"
STORE_CODE="${STORE_CODE:-westside}"
STORE_NAME="${STORE_NAME:-Westside}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
MODULES="${MODULES:-commerce-core,commerce-b2b,content,invoices}"
PROVIDER="${PROVIDER:-one-c}"
DEPLOY_DIR="deployment"
CONFIG_DIR="$DEPLOY_DIR/config"
SECRETS_DIR="$DEPLOY_DIR/secrets"
ENV_FILE="$SECRETS_DIR/.env"
PROFILE_FILE="$CONFIG_DIR/store-profile.json"

# --- args -------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN=1 ;;
    --non-interactive) INTERACTIVE=0 ;;
    --domain) DOMAIN="$2"; shift ;;
    --store-code) STORE_CODE="$2"; shift ;;
    --store-name) STORE_NAME="$2"; shift ;;
    --admin-email) ADMIN_EMAIL="$2"; shift ;;
    --modules) MODULES="$2"; shift ;;
    --provider) PROVIDER="$2"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

gen_secret() {
  if have openssl; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

prompt() { # prompt VAR "label" "default"
  _var="$1"; _label="$2"; _default="$3"
  eval "_cur=\${$_var}"
  if [ "$INTERACTIVE" -eq 1 ]; then
    if [ -n "$_default" ]; then printf '%s [%s]: ' "$_label" "$_default"; else printf '%s: ' "$_label"; fi
    read -r _ans || _ans=""
    [ -z "$_ans" ] && _ans="${_cur:-$_default}"
  else
    _ans="${_cur:-$_default}"
  fi
  eval "$_var=\$_ans"
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# --- plan mode: preview only, no checks, no writes --------------------------
if [ "$PLAN" -eq 1 ]; then
  log "AXIMA Commerce install plan (dry-run — nothing is written):"
  log "  domain:        ${DOMAIN:-<prompted at install>}"
  log "  store:         $STORE_CODE / $STORE_NAME"
  log "  admin email:   ${ADMIN_EMAIL:-<prompted at install>}"
  log "  modules:       $MODULES"
  log "  erp provider:  $PROVIDER"
  log "  profile file:  $PROFILE_FILE (created if absent)"
  log "  env file:      $ENV_FILE (secrets generated if absent, 0600)"
  log "  steps:         checks -> secrets -> profile -> compose build -> postgres -> migrate deploy -> bootstrap -> app -> nginx -> https -> health"
  log "No files were written and no activation was consumed."
  exit 0
fi

# --- environment checks -----------------------------------------------------
[ "$(uname -s)" = "Linux" ] || die "Supported target is Linux. Detected $(uname -s)."
have docker || die "docker is required. Install Docker Engine and re-run."
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required."

# --- interactive configuration ----------------------------------------------
prompt DOMAIN "Public domain (e.g. shop.example.com)" ""
prompt STORE_CODE "Store code" "$STORE_CODE"
prompt STORE_NAME "Store name" "$STORE_NAME"
prompt ADMIN_EMAIL "Initial administrator email" ""
prompt PROVIDER "Primary ERP provider (one-c/moysklad/custom)" "$PROVIDER"
[ -n "$DOMAIN" ] || die "domain is required"
[ -n "$ADMIN_EMAIL" ] || die "administrator email is required"

mkdir -p "$CONFIG_DIR" "$SECRETS_DIR"
chmod 700 "$DEPLOY_DIR" "$SECRETS_DIR" 2>/dev/null || true

# --- secrets (.env) — generated once, never reset ---------------------------
if [ -f "$ENV_FILE" ]; then
  log "Reusing existing secrets in $ENV_FILE (not regenerated)."
  # shellcheck disable=SC1090
  . "$ENV_FILE"
else
  POSTGRES_PASSWORD="$(gen_secret)"
  NEXTAUTH_SECRET="$(gen_secret)"
  DATABASE_URL="postgresql://westside:${POSTGRES_PASSWORD}@postgres:5432/westside"
  umask 077
  {
    echo "POSTGRES_USER=westside"
    echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
    echo "POSTGRES_DB=westside"
    echo "DATABASE_URL=${DATABASE_URL}"
    echo "NEXTAUTH_URL=https://${DOMAIN}"
    echo "NEXTAUTH_SECRET=${NEXTAUTH_SECRET}"
    echo "STORE_PROFILE_PATH=/app/deployment/config/store-profile.json"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "Generated secrets in $ENV_FILE (0600)."
fi

# --- store profile — created once, preserved on re-run ----------------------
if [ -f "$PROFILE_FILE" ]; then
  log "Reusing existing profile in $PROFILE_FILE (not overwritten)."
else
  _modules_json=$(printf '%s' "$MODULES" | awk -F, '{for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?",":""), $i}}')
  cat > "$PROFILE_FILE" <<JSON
{
  "schemaVersion": 1,
  "store": { "code": "$(json_escape "$STORE_CODE")", "name": "$(json_escape "$STORE_NAME")", "baseUrl": "https://$(json_escape "$DOMAIN")" },
  "admin": { "email": "$(json_escape "$ADMIN_EMAIL")", "name": "Administrator" },
  "modules": [${_modules_json}],
  "integration": { "provider": "$(json_escape "$PROVIDER")" },
  "runtime": { "catalogRequiresAuth": true, "registration": "manual", "requireAgeConfirmation": true, "defaultChannelCode": "DEFAULT" }
}
JSON
  chmod 644 "$PROFILE_FILE"
  log "Wrote store profile to $PROFILE_FILE."
fi

# --- admin password ---------------------------------------------------------
ADMIN_PASSWORD_GENERATED=0
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ADMIN_PASSWORD="$(gen_secret | cut -c1-24)"
  ADMIN_PASSWORD_GENERATED=1
fi

# --- build + database + migrate + bootstrap ---------------------------------
log "Building application image..."
docker compose --env-file "$ENV_FILE" build app
log "Starting database..."
docker compose --env-file "$ENV_FILE" up -d postgres
log "Waiting for database to become healthy..."
i=0; while [ "$i" -lt 30 ]; do
  s=$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null || echo "")
  [ "$s" = "healthy" ] && break
  i=$((i+1)); sleep 2
done
[ "$s" = "healthy" ] || die "database did not become healthy"

log "Applying migrations and bootstrapping..."
docker compose --env-file "$ENV_FILE" run --rm \
  -e ADMIN_EMAIL="$ADMIN_EMAIL" -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e STORE_PROFILE_PATH="/app/deployment/config/store-profile.json" \
  -v "$(pwd)/$DEPLOY_DIR:/app/deployment" \
  app sh -c "node_modules/.bin/prisma migrate deploy && node scripts/bootstrap.mjs"

log "Starting application..."
docker compose --env-file "$ENV_FILE" --profile full up -d app

# --- reverse proxy (optional; requires nginx + privileges) ------------------
if have nginx; then
  SITE="/etc/nginx/sites-available/${DOMAIN}"
  if [ -w "$(dirname "$SITE")" ] || [ "$(id -u)" = "0" ]; then
    sed "s/__DOMAIN__/${DOMAIN}/g" deploy/nginx.conf.template > "$SITE"
    ln -sf "$SITE" "/etc/nginx/sites-enabled/${DOMAIN}" 2>/dev/null || true
    nginx -t && (systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true)
    log "Configured nginx site for ${DOMAIN}."
  else
    log "nginx present but insufficient privileges; run as root to install the site."
  fi
else
  log "nginx not found; skipping reverse proxy (configure it before exposing ${DOMAIN})."
fi

# --- HTTPS (optional; Let's Encrypt) ----------------------------------------
if have certbot; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" || log "certbot failed; deployment remains on HTTP until TLS is configured."
else
  log "certbot not found; configure HTTPS before production use."
fi

# --- health check -----------------------------------------------------------
log "Health check..."
HEALTH_URL="http://127.0.0.1:3000/api/health"
if have curl; then
  curl -fsS "$HEALTH_URL" >/dev/null 2>&1 && APP_STATUS="ok" || APP_STATUS="unreachable"
else
  APP_STATUS="unknown (curl missing)"
fi

# --- summary ----------------------------------------------------------------
log ""
log "==================== AXIMA Commerce install summary ===================="
log "  URL:            https://${DOMAIN}"
log "  application:    ${APP_STATUS}"
log "  database:       up"
log "  license:        $( [ -f "$CONFIG_DIR/license.json" ] && echo present || echo 'absent (dev/mock — enforcement in M10)')"
log "  admin email:    ${ADMIN_EMAIL}"
if [ "$ADMIN_PASSWORD_GENERATED" -eq 1 ]; then
  log "  admin password: ${ADMIN_PASSWORD}   <-- shown once, change after first login"
fi
log ""
log "  Next steps:"
log "    - Point DNS for ${DOMAIN} at this server if not done."
log "    - If HTTPS was skipped, run certbot --nginx -d ${DOMAIN}."
log "    - Configure the Operational Provider / 1C connection in the backoffice (M4)."
log "========================================================================"
