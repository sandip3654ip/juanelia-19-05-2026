#!/bin/bash
# ==============================================================
#  TradingShip — One-Command VPS Setup
#  Usage:  bash setup.sh
#  Run from inside the cloned repo folder
# ==============================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERR ]${NC} $1"; exit 1; }
step()  { echo -e "\n${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  $1\n${NC}"; }

# ── App root = folder containing this script ──────────────────
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

clear
echo -e "${BOLD}${CYAN}"
cat << 'LOGO'

  ████████╗██████╗  █████╗ ██████╗ ██╗███╗  ██╗ ██████╗
  ╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██║████╗ ██║██╔════╝
     ██║   ██████╔╝███████║██║  ██║██║██╔██╗██║██║ ███╗
     ██║   ██╔══██╗██╔══██║██║  ██║██║██║╚████║██║  ██║
     ██║   ██║  ██║██║  ██║██████╔╝██║██║ ╚███║╚██████╔╝
     ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚══╝ ╚═════╝

LOGO
echo -e "${NC}  ${CYAN}CCXT Pro Edition — VPS Setup${NC}"
echo -e "  App folder: ${BOLD}${APP_DIR}${NC}"
echo ""

# ── Must be root ──────────────────────────────────────────────
[ "$EUID" -eq 0 ] || err "Run as root:  sudo bash setup.sh"

# ==============================================================
step "STEP 1/10 — System update"
# ==============================================================
apt-get update -qq && apt-get upgrade -y -qq
ok "System packages updated"

# ==============================================================
step "STEP 2/10 — Node.js 20"
# ==============================================================
export NVM_DIR="$HOME/.nvm"
if [ ! -f "$NVM_DIR/nvm.sh" ]; then
  info "Installing NVM..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"

NODE_MAJOR=0
command -v node &>/dev/null && NODE_MAJOR=$(node --version | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
  info "Installing Node.js 20..."
  nvm install 20
fi
nvm use 20
nvm alias default 20
ok "Node.js $(node --version)"

# ==============================================================
step "STEP 3/10 — pnpm + PM2"
# ==============================================================
command -v pnpm &>/dev/null || npm install -g pnpm
command -v pm2  &>/dev/null || npm install -g pm2

# Log rotation — prevent disk fill
pm2 install pm2-logrotate --silent 2>/dev/null || true
pm2 set pm2-logrotate:max_size 100M 2>/dev/null || true
pm2 set pm2-logrotate:retain   7   2>/dev/null || true

ok "pnpm $(pnpm --version)"
ok "PM2  $(pm2 --version)"

# ==============================================================
step "STEP 4/10 — PostgreSQL"
# ==============================================================
if ! command -v psql &>/dev/null; then
  info "Installing PostgreSQL..."
  apt-get install -y postgresql postgresql-contrib -qq
fi
systemctl start postgresql
systemctl enable postgresql
ok "PostgreSQL $(psql --version | awk '{print $3}')"

# Auto-generate a strong DB password
DB_PASS="ts_$(openssl rand -hex 14)"

DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='tradingship'" 2>/dev/null || echo "0")
if [ "$DB_EXISTS" != "1" ]; then
  info "Creating database & user 'tradingship'..."
  sudo -u postgres psql << SQLEOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'tradingship') THEN
    CREATE USER tradingship WITH PASSWORD '${DB_PASS}';
  ELSE
    ALTER  USER tradingship WITH PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE tradingship OWNER tradingship'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tradingship')\gexec
GRANT ALL PRIVILEGES ON DATABASE tradingship TO tradingship;
SQLEOF
  ok "Database created  (user: tradingship  pass: ${DB_PASS})"
else
  # Reset password so .env stays in sync
  sudo -u postgres psql -c "ALTER USER tradingship WITH PASSWORD '${DB_PASS}';" -q
  ok "Database already exists — password refreshed"
fi

DATABASE_URL="postgresql://tradingship:${DB_PASS}@localhost:5432/tradingship"

# ==============================================================
step "STEP 5/10 — .env configuration"
# ==============================================================
SESSION_SECRET="$(openssl rand -hex 48)"

ENV_FILE="$APP_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  info "Creating .env..."
  cat > "$ENV_FILE" << ENVEOF
NODE_ENV=production
PORT=5000

# ── REQUIRED ────────────────────────────────────────────────
DATABASE_URL=${DATABASE_URL}
SESSION_SECRET=${SESSION_SECRET}

# ── OPTIONAL: Exchange API keys ─────────────────────────────
# Without keys: KuCoin + Bitget ONLINE (200+ opportunities)
# With keys:    All 4 exchanges ONLINE (400+ opportunities)

# BINANCE_API_KEY=your_binance_read_only_key

# BYBIT_API_KEY=your_bybit_key
# BYBIT_API_SECRET=your_bybit_secret

# COINSWITCH_API_KEY=your_coinswitch_key
# COINSWITCH_API_SECRET=your_coinswitch_secret
ENVEOF
  chmod 600 "$ENV_FILE"
  ok ".env created with auto-generated secrets"
else
  # Keep existing .env — only add missing vars
  grep -q "^DATABASE_URL="   "$ENV_FILE" || echo "DATABASE_URL=${DATABASE_URL}"   >> "$ENV_FILE"
  grep -q "^SESSION_SECRET=" "$ENV_FILE" || echo "SESSION_SECRET=${SESSION_SECRET}" >> "$ENV_FILE"
  ok ".env already exists — kept as-is (missing vars appended)"
fi

# Patch ecosystem.config.cjs with the correct absolute app path
sed -i "s|cwd:.*\".*\"|cwd: \"${APP_DIR}\"|g" "$APP_DIR/ecosystem.config.cjs"
ok "ecosystem.config.cjs  cwd → ${APP_DIR}"

# ==============================================================
step "STEP 6/10 — Install dependencies  (ccxt, express, drizzle…)"
# ==============================================================
cd "$APP_DIR"
pnpm install --frozen-lockfile
ok "All packages installed"

# ==============================================================
step "STEP 7/10 — Database schema push"
# ==============================================================
set -a; source "$ENV_FILE"; set +a
pnpm --filter @workspace/db run push \
  && ok "Database schema ready" \
  || warn "DB push had issues — verify DATABASE_URL in .env then run:  pnpm --filter @workspace/db run push"

# ==============================================================
step "STEP 8/10 — Build API server  (TypeScript → JavaScript)"
# ==============================================================
pnpm --filter @workspace/api-server run build
SIZE=$(du -sh "$APP_DIR/artifacts/api-server/dist/index.mjs" 2>/dev/null | cut -f1 || echo "?")
ok "Build done — dist/index.mjs (${SIZE})"

# ==============================================================
step "STEP 9/10 — Start with PM2"
# ==============================================================
mkdir -p /var/log/tradingship

if pm2 list | grep -q "tradingship"; then
  pm2 reload tradingship
  ok "PM2 process reloaded"
else
  pm2 start "$APP_DIR/ecosystem.config.cjs"
  ok "PM2 process started"
fi
pm2 save

# ==============================================================
step "STEP 10/10 — Boot auto-start + health check"
# ==============================================================
STARTUP_OUT=$(pm2 startup systemd -u root --hp /root 2>&1 || true)
STARTUP_CMD=$(echo "$STARTUP_OUT" | grep "sudo env" || true)
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD" 2>/dev/null && ok "PM2 auto-start on reboot — enabled" \
    || warn "Run this manually to enable auto-start:\n  $STARTUP_CMD"
else
  ok "PM2 startup already configured"
fi

info "Waiting 10 seconds for server to start..."
sleep 10

if curl -sf http://localhost:5000/api/healthz > /dev/null 2>&1; then
  ok "Health check PASSED — /api/healthz → 200"
else
  warn "Health check failed — showing last 20 log lines:"
  pm2 logs tradingship --lines 20 --nostream 2>/dev/null || true
fi

# ── Print summary ─────────────────────────────────────────────
VPS_IP=$(curl -sf --max-time 3 ifconfig.me 2>/dev/null || echo "YOUR_VPS_IP")

echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║           Setup complete! App is LIVE.              ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  ${BOLD}Live status page →${NC}  http://${VPS_IP}:5000/api/"
echo -e "  ${BOLD}Health check     →${NC}  http://${VPS_IP}:5000/api/healthz"
echo -e "  ${BOLD}Opportunities    →${NC}  http://${VPS_IP}:5000/api/spot/opportunities"
echo ""
echo -e "  ${BOLD}Exchange status (after ~30s):${NC}"
echo -e "    ${GREEN}●${NC} KuCoin   ONLINE  (no API key needed)"
echo -e "    ${GREEN}●${NC} Bitget   ONLINE  (no API key needed)"
echo -e "    ${RED}●${NC} Binance  needs API key  →  nano ${ENV_FILE}"
echo -e "    ${RED}●${NC} Bybit    needs API key  →  nano ${ENV_FILE}"
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo -e "    pm2 status                   # is app running?"
echo -e "    pm2 logs tradingship         # live logs"
echo -e "    pm2 restart tradingship      # restart after .env change"
echo -e "    nano ${ENV_FILE}   # add API keys / edit config"
echo ""
echo -e "  ${BOLD}Add Binance/Bybit keys (optional — 4x more opportunities):${NC}"
echo -e "    nano ${ENV_FILE}"
echo -e "    # Uncomment BINANCE_API_KEY / BYBIT_API_KEY lines"
echo -e "    pm2 restart tradingship"
echo ""
echo -e "  ${BOLD}Update code from GitHub:${NC}"
echo -e "    cd ${APP_DIR}"
echo -e "    git pull"
echo -e "    pnpm install --frozen-lockfile"
echo -e "    pnpm --filter @workspace/api-server run build"
echo -e "    pm2 restart tradingship"
echo ""
