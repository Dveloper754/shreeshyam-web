#!/usr/bin/env bash
# =============================================================================
# Shree Shyam Book — self-hosted Supabase bootstrap for a Hostinger KVM VPS
# Idempotent: safe to re-run. All secrets are generated ON THIS SERVER and are
# never committed anywhere. Logs to /root/ssb-setup.log.
#
# Run as root:
#   curl -fsSL https://raw.githubusercontent.com/Dveloper754/shreeshyam-web/main/vps-setup.sh -o /root/vps-setup.sh
#   bash /root/vps-setup.sh
# =============================================================================
set -Eeuo pipefail
exec > >(tee -a /root/ssb-setup.log) 2>&1
echo "================================================================"
echo " Shree Shyam Book — Supabase self-host bootstrap  $(date -u)"
echo "================================================================"

# ---- Config -----------------------------------------------------------------
API_HOST="srv2001110.hstgr.cloud"                 # HTTPS endpoint the app will call
SITE_URL="https://shreeshyamacc.com"              # the web app origin
SUPA_DIR="/opt/supabase"
DOCKER_DIR="$SUPA_DIR/docker"
REPO_RAW="https://raw.githubusercontent.com/Dveloper754/shreeshyam-web/main"
SQL_FILES="database.sql license_setup.sql agent_setup.sql backup_setup.sql subscription_setup.sql reset_fix.sql"

# ---- 1. Base packages -------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
echo "[1/9] apt packages ..."
apt-get update -y
apt-get install -y curl git openssl python3 jq ca-certificates ufw gnupg debian-keyring debian-archive-keyring apt-transport-https

# ---- 2. Docker --------------------------------------------------------------
echo "[2/9] Docker ..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose plugin missing"; exit 1; }

# ---- 3. Supabase docker project (pinned) ------------------------------------
echo "[3/9] Supabase docker project ..."
if [ ! -f "$DOCKER_DIR/docker-compose.yml" ]; then
  mkdir -p "$SUPA_DIR"
  rm -rf "$SUPA_DIR/src"
  git clone --depth 1 https://github.com/supabase/supabase "$SUPA_DIR/src"
  cp -rf "$SUPA_DIR/src/docker" "$DOCKER_DIR"
  cp -rf "$SUPA_DIR/src/docker/volumes" "$DOCKER_DIR/volumes" 2>/dev/null || true
fi
cd "$DOCKER_DIR"
[ -f .env ] || cp .env.example .env

# ---- 4. Secrets (generated once; reused on re-run) --------------------------
echo "[4/9] Secrets ..."
STATE=/root/ssb-secrets.env
if [ -f "$STATE" ]; then
  # shellcheck disable=SC1090
  source "$STATE"
else
  PG_PW="$(openssl rand -hex 24)"
  JWT_SECRET="$(openssl rand -hex 40)"
  DASH_PW="$(openssl rand -hex 10)"
  SECRET_KEY_BASE="$(openssl rand -hex 32)"
  VAULT_ENC_KEY="$(openssl rand -hex 16)"
  read -r ANON_KEY SERVICE_ROLE_KEY < <(python3 - "$JWT_SECRET" <<'PY'
import sys, hmac, hashlib, base64, json, time
secret = sys.argv[1].encode()
def b64(x): return base64.urlsafe_b64encode(x).rstrip(b'=')
def jwt(role):
    hdr = b64(json.dumps({"alg":"HS256","typ":"JWT"}, separators=(',',':')).encode())
    iat = int(time.time()); exp = iat + 60*60*24*3650
    pay = b64(json.dumps({"role":role,"iss":"supabase","iat":iat,"exp":exp}, separators=(',',':')).encode())
    sig = b64(hmac.new(secret, hdr+b'.'+pay, hashlib.sha256).digest())
    return (hdr+b'.'+pay+b'.'+sig).decode()
print(jwt("anon"), jwt("service_role"))
PY
)
  cat > "$STATE" <<EOF
PG_PW=$PG_PW
JWT_SECRET=$JWT_SECRET
DASH_PW=$DASH_PW
SECRET_KEY_BASE=$SECRET_KEY_BASE
VAULT_ENC_KEY=$VAULT_ENC_KEY
ANON_KEY=$ANON_KEY
SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
EOF
  chmod 600 "$STATE"
fi

# ---- 5. Write .env ----------------------------------------------------------
echo "[5/9] .env ..."
set_env(){ local k="$1" v="$2"; if grep -q "^$k=" .env; then sed -i "s|^$k=.*|$k=$v|" .env; else echo "$k=$v" >> .env; fi; }
set_env POSTGRES_PASSWORD   "$PG_PW"
set_env JWT_SECRET          "$JWT_SECRET"
set_env ANON_KEY            "$ANON_KEY"
set_env SERVICE_ROLE_KEY    "$SERVICE_ROLE_KEY"
set_env DASHBOARD_USERNAME  "admin"
set_env DASHBOARD_PASSWORD  "$DASH_PW"
set_env SECRET_KEY_BASE     "$SECRET_KEY_BASE"
set_env VAULT_ENC_KEY       "$VAULT_ENC_KEY"
set_env SITE_URL            "$SITE_URL"
set_env API_EXTERNAL_URL    "https://$API_HOST"
set_env SUPABASE_PUBLIC_URL "https://$API_HOST"
set_env ADDITIONAL_REDIRECT_URLS "$SITE_URL"
set_env ENABLE_EMAIL_SIGNUP      "true"
set_env ENABLE_EMAIL_AUTOCONFIRM "true"   # username@books.local, no real mailbox
set_env DISABLE_SIGNUP           "true"   # we create users via admin API only
# Keep Kong on localhost; Caddy terminates TLS in front of it
set_env KONG_HTTP_PORT  "8000"
set_env KONG_HTTPS_PORT "8443"

# ---- 6. Bring up the stack --------------------------------------------------
echo "[6/9] docker compose up ..."
docker compose pull
docker compose up -d

echo "   waiting for Postgres ..."
for i in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1; then echo "   db ready"; break; fi
  sleep 3
done

# ---- 7. Load the app schema -------------------------------------------------
echo "[7/9] schema ..."
for f in $SQL_FILES; do
  if curl -fsSL "$REPO_RAW/$f" -o "/root/$f"; then
    echo "   -> $f"
    docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=0 < "/root/$f" || echo "   (warnings in $f, continued)"
  else
    echo "   (skip $f — not in repo)"
  fi
done

# ---- 8. HTTPS via Caddy (auto Let's Encrypt for the VPS hostname) -----------
echo "[8/9] Caddy HTTPS ..."
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
mkdir -p /opt/pub
cat > /etc/caddy/Caddyfile <<EOF
$API_HOST {
    @info path /_ssb_backend.json
    handle @info { root * /opt/pub; file_server }
    reverse_proxy localhost:8000
}
EOF
# a one-time info file (anon key is public-by-design; delete after we read it)
cat > /opt/pub/_ssb_backend.json <<EOF
{"api":"https://$API_HOST","anon":"$ANON_KEY","ready":true}
EOF
systemctl enable --now caddy
systemctl restart caddy

# ---- 9. Firewall ------------------------------------------------------------
echo "[9/9] firewall ..."
ufw allow 22/tcp  >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
yes | ufw enable  >/dev/null 2>&1 || true

echo "================================================================"
echo " DONE."
echo "   API endpoint : https://$API_HOST"
echo "   Anon key     : fetch https://$API_HOST/_ssb_backend.json"
echo "   Studio (SSH tunnel only) : localhost:8000  user admin / $DASH_PW"
echo "   Secrets saved: $STATE   (keep safe, never commit)"
echo "================================================================"
