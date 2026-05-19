#!/bin/bash
# ============================================================
#  MONEY MACHINE — Hostinger VPS Auto Setup Script
#  Run as root: bash setup-vps.sh
#  Tested & verified ✓
# ============================================================

set -e

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }
head_s(){ echo -e "\n${BLUE}══════════════════════════════════════${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}══════════════════════════════════════${NC}"; }

# ── CONFIG — SIRF YE LINES EDIT KARO ─────────────────────────
DOMAIN="tradingship.online"          # ← apna domain yahan likho
DB_NAME="moneymachine"
DB_USER="mmuser"
DB_PASS="$(openssl rand -base64 20 | tr -dc 'a-zA-Z0-9' | head -c 20)"
APP_DIR="/var/www/money-machine"
# ─────────────────────────────────────────────────────────────

# Script project root se chalna chahiye
if [ ! -f "pnpm-workspace.yaml" ]; then
  err "Galat folder! Is script ko project ke root folder se chalao.\ncd /root/money-machine && bash scripts/deploy/setup-vps.sh"
fi

head_s "Step 1: System Update"
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git nano unzip build-essential software-properties-common rsync
log "System ready"

head_s "Step 2: Node.js 20 Install"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs -qq
  log "Node.js installed"
else
  log "Node.js $(node --version) already installed"
fi

head_s "Step 3: pnpm + PM2 Install"
if ! command -v pnpm &>/dev/null; then
  npm install -g pnpm --silent
  log "pnpm $(pnpm --version) installed"
else
  log "pnpm already installed"
fi
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --silent
  log "PM2 installed"
else
  log "PM2 already installed"
fi

head_s "Step 4: PostgreSQL Install"
if ! command -v psql &>/dev/null; then
  apt-get install -y postgresql postgresql-contrib -qq
  log "PostgreSQL installed"
else
  log "PostgreSQL already installed"
fi
systemctl start postgresql
systemctl enable postgresql

# Database aur user banana
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME};" >/dev/null
sudo -u postgres psql -tc "SELECT 1 FROM pg_user WHERE usename='${DB_USER}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" >/dev/null
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};" >/dev/null
sudo -u postgres psql -c "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};" >/dev/null

DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"
log "Database ready"
echo ""
echo -e "  ${YELLOW}DATABASE_URL=${DATABASE_URL}${NC}"
echo -e "  ${YELLOW}(ye .env mein save hogi — khud yaad karne ki zarurat nahi)${NC}"
echo ""

head_s "Step 5: Nginx Install"
if ! command -v nginx &>/dev/null; then
  apt-get install -y nginx -qq
fi
systemctl enable nginx
log "Nginx ready"

head_s "Step 6: Certbot (SSL) Install"
if ! command -v certbot &>/dev/null; then
  apt-get install -y certbot python3-certbot-nginx -qq
fi
log "Certbot ready"

head_s "Step 7: Source Code Copy"
mkdir -p ${APP_DIR}
rsync -a \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='attached_assets' \
  --exclude='.local' \
  --exclude='.env' \
  . ${APP_DIR}/
log "Code copied to ${APP_DIR}"

head_s "Step 8: .env File Create"
SESSION_SECRET="$(openssl rand -hex 32)"

if [ ! -f "${APP_DIR}/.env" ]; then
cat > ${APP_DIR}/.env << ENVEOF
# ── Database ─────────────────────────────────────────────────
DATABASE_URL=${DATABASE_URL}

# ── Auth (REQUIRED — bina in ke login nahi hoga) ─────────────
FAST2SMS_API_KEY=YAHAN_APNI_FAST2SMS_KEY_DAALO
REGISTERED_PHONE=YAHAN_APNA_NUMBER_DAALO

# ── Session Secret (auto-generated) ──────────────────────────
SESSION_SECRET=${SESSION_SECRET}

# ── Server ───────────────────────────────────────────────────
PORT=8080
NODE_ENV=production

# ── AI (Ollama) ───────────────────────────────────────────────
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b

# ── Telegram Alerts (Optional) ───────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# ── Exchange APIs (Optional) ─────────────────────────────────
BINANCE_API_KEY=
BINANCE_API_SECRET=
BYBIT_API_KEY=
BYBIT_API_SECRET=
BITGET_API_KEY=
BITGET_API_SECRET=
BITGET_API_PASSPHRASE=
KUCOIN_API_KEY=
KUCOIN_API_SECRET=
KUCOIN_API_PASSPHRASE=
COINSWITCH_API_KEY=
COINSWITCH_API_SECRET=
ENVEOF
  log ".env file bani"
  warn "IMPORTANT: .env mein Fast2SMS key aur phone number bharo"
  warn "Command: nano ${APP_DIR}/.env"
else
  log ".env already exists — skip (existing values safe hain)"
fi

head_s "Step 9: Dependencies Install"
cd ${APP_DIR}
pnpm install --frozen-lockfile 2>&1 | tail -3
log "Dependencies installed"

head_s "Step 10: Database Tables Create"
set -a; source ${APP_DIR}/.env; set +a
cd ${APP_DIR}
pnpm --filter @workspace/db run push-force
log "Database tables created"

head_s "Step 11: Build API Server"
cd ${APP_DIR}
pnpm --filter @workspace/api-server run build
log "API server built → artifacts/api-server/dist/index.mjs"

head_s "Step 12: Build Frontend"
cd ${APP_DIR}
BASE_PATH="/" pnpm --filter @workspace/dex-dashboard run build
log "Frontend built → artifacts/dex-dashboard/dist/public/"

head_s "Step 13: Nginx Config"
cat > /etc/nginx/sites-available/moneymachine << NGINXEOF
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};

    # Static frontend files
    root ${APP_DIR}/artifacts/dex-dashboard/dist/public;
    index index.html;

    # API requests → Node.js backend
    location /api {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300;
        proxy_connect_timeout 300;
        proxy_buffering off;
    }

    # WebSocket support
    location /api/ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }

    # React SPA — sab routes index.html pe
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
NGINXEOF

ln -sf /etc/nginx/sites-available/moneymachine /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
log "Nginx configured for ${DOMAIN}"

head_s "Step 14: PM2 Setup"
mkdir -p /var/log/pm2

cat > ${APP_DIR}/ecosystem.config.cjs << PM2EOF
module.exports = {
  apps: [{
    name: 'money-machine',
    script: '${APP_DIR}/artifacts/api-server/dist/index.mjs',
    cwd: '${APP_DIR}',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env_file: '${APP_DIR}/.env',
    env: {
      NODE_ENV: 'production',
      PORT: 8080
    },
    error_file: '/var/log/pm2/mm-error.log',
    out_file: '/var/log/pm2/mm-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
PM2EOF

pm2 start ${APP_DIR}/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash 2>/dev/null || true
log "PM2 started — server auto-start on reboot set"

head_s "Step 15: SSL Certificate (HTTPS)"
echo ""
warn "SSL ke liye domain '${DOMAIN}' pehle is VPS IP par point hona chahiye"
read -p "SSL certificate lagayein abhi? (y/n): " ssl_choice
if [[ "$ssl_choice" == "y" || "$ssl_choice" == "Y" ]]; then
  certbot --nginx \
    -d ${DOMAIN} -d www.${DOMAIN} \
    --non-interactive --agree-tos \
    -m "admin@${DOMAIN}" \
    --redirect
  systemctl enable certbot.timer
  log "SSL installed! App HTTPS par live hai"
else
  warn "SSL baad mein lagao: certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}"
fi

# ── Ollama + Qwen 2.5 7B Install ─────────────────────────────
head_s "Step 15b: Ollama AI Install (Qwen 2.5 7B)"
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
  log "Ollama installed"
else
  log "Ollama already installed"
fi

# Start Ollama as systemd service
if ! systemctl is-active --quiet ollama; then
  systemctl enable ollama 2>/dev/null || true
  systemctl start ollama  2>/dev/null || true
  sleep 3
fi

# Pull Qwen model (this takes 5-15 min depending on internet speed)
warn "Qwen 2.5 7B model download ho raha hai (~4.7 GB) — please wait..."
ollama pull qwen2.5:7b
log "Qwen 2.5 7B model ready"

# Verify Ollama is responding
OLLAMA_TEST=$(curl -s http://localhost:11434/api/tags 2>/dev/null || echo "error")
if [[ "$OLLAMA_TEST" == *"models"* ]]; then
  log "Ollama API: RUNNING ✓"
else
  warn "Ollama may need manual start: ollama serve"
fi

# ── Final Status Check ────────────────────────────────────────
head_s "Verification"
sleep 2

API_STATUS=$(curl -s http://127.0.0.1:8080/api/healthz 2>/dev/null || echo "error")
if [[ "$API_STATUS" == *"ok"* ]]; then
  log "API Server: RUNNING ✓"
else
  warn "API Server response: ${API_STATUS}"
  warn "Logs check: pm2 logs money-machine --lines 20"
fi

NGINX_STATUS=$(systemctl is-active nginx)
if [[ "$NGINX_STATUS" == "active" ]]; then
  log "Nginx: RUNNING ✓"
else
  warn "Nginx status: ${NGINX_STATUS}"
fi

# ── Done ──────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     MONEY MACHINE DEPLOY COMPLETE!       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  App URL:   ${BLUE}http://${DOMAIN}${NC}"
echo -e "  API Check: ${BLUE}http://${DOMAIN}/api/healthz${NC}"
echo -e "  App Folder: ${BLUE}${APP_DIR}${NC}"
echo ""
echo -e "${YELLOW}NEXT STEP — .env mein ye zaroor bharo:${NC}"
echo -e "  nano ${APP_DIR}/.env"
echo ""
echo -e "  FAST2SMS_API_KEY=<apni_key>"
echo -e "  REGISTERED_PHONE=<apna_number>"
echo ""
echo -e "Phir restart karo: ${BLUE}pm2 restart money-machine${NC}"
echo ""
echo -e "Useful commands:"
echo -e "  pm2 status              — server status"
echo -e "  pm2 logs money-machine  — live logs"
echo -e "  pm2 restart money-machine — restart"
echo -e "  nginx -t                — nginx config check"
