#!/bin/bash
# ============================================================
#  MONEY MACHINE — Update Script
#  Naya code VPS par deploy karne ke liye
#  Run: bash /root/money-machine/scripts/deploy/update.sh
# ============================================================

set -e
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
head_s(){ echo -e "\n${BLUE}── $1 ──${NC}"; }

APP_DIR="/var/www/money-machine"
SOURCE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if [ ! -f "${SOURCE_DIR}/pnpm-workspace.yaml" ]; then
  echo "Galat folder! Update script project root se chalao."
  exit 1
fi

head_s "1. Source code sync"
rsync -a \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='.env' \
  --exclude='attached_assets' \
  --exclude='.local' \
  ${SOURCE_DIR}/ ${APP_DIR}/
log "Code synced"

head_s "2. Dependencies"
cd ${APP_DIR}
pnpm install --frozen-lockfile 2>&1 | tail -3
log "Dependencies updated"

head_s "3. Database schema"
set -a; source ${APP_DIR}/.env; set +a
pnpm --filter @workspace/db run push
log "DB schema up to date"

head_s "4. Build API server"
pnpm --filter @workspace/api-server run build
log "API server built"

head_s "5. Build frontend"
BASE_PATH="/" pnpm --filter @workspace/dex-dashboard run build
log "Frontend built"

head_s "6. Restart server"
pm2 restart money-machine
sleep 2
log "Server restarted"

head_s "Verification"
API_STATUS=$(curl -s http://127.0.0.1:8080/api/healthz 2>/dev/null || echo "error")
if [[ "$API_STATUS" == *"ok"* ]]; then
  log "API: RUNNING ✓"
else
  warn "API status: ${API_STATUS} — check: pm2 logs money-machine"
fi

echo ""
echo -e "${GREEN}Update complete!${NC}"
pm2 status money-machine
