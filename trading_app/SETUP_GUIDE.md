# TradingShip — VPS Setup Guide (Starting se)
# 0 se shuru karke production mein live karne tak

---

## OVERVIEW — Kya karna hai

```
[Your Machine]                    [VPS — Ubuntu 22.04]
tradingship-ccxt.tar.gz  ──SCP──►  /root/tradingship/
                                   ├── pnpm install
                                   ├── DB setup (PostgreSQL)
                                   ├── .env configure
                                   ├── pnpm build
                                   ├── PM2 start
                                   └── Nginx + SSL (optional)
```

---

## STEP 1 — VPS kharido / prepare karo

**Recommended specs:**
- RAM: 2GB minimum (4GB better — CCXT Pro loads ~800MB market data)
- CPU: 2 vCPU
- OS: Ubuntu 22.04 LTS
- Provider: DigitalOcean, Hetzner, Vultr, Contabo (koi bhi chalega)

**Root ke roop mein SSH karo:**
```bash
ssh root@YOUR_VPS_IP
```

---

## STEP 2 — System update + Node.js install

```bash
# System update
apt update && apt upgrade -y

# NVM (Node version manager) install
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Shell reload karo (logout + login ya yeh run karo)
source ~/.bashrc

# Node.js 20 install
nvm install 20
nvm use 20
nvm alias default 20

# Verify
node --version   # v20.x.x hona chahiye
npm --version    # 10.x.x
```

---

## STEP 3 — pnpm + PM2 install

```bash
# pnpm (package manager)
npm install -g pnpm
pnpm --version   # 9.x

# PM2 (process manager — app ko background mein rakhta hai, crash pe restart karta hai)
npm install -g pm2
pm2 --version

# PM2 log rotation (logs disk full na kare)
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 7
```

---

## STEP 4 — PostgreSQL install + setup

```bash
# Install
apt install -y postgresql postgresql-contrib

# Start + enable on boot
systemctl start postgresql
systemctl enable postgresql

# Database + user banao
sudo -u postgres psql << 'EOF'
CREATE USER tradingship WITH PASSWORD 'StrongPassword123!';
CREATE DATABASE tradingship OWNER tradingship;
GRANT ALL PRIVILEGES ON DATABASE tradingship TO tradingship;
\q
EOF

# Connection test
psql "postgresql://tradingship:StrongPassword123!@localhost:5432/tradingship" -c "SELECT 1;"
# Should print:  ?column?
#  ----------
#       1
```

---

## STEP 5 — Code upload karo (apni machine se)

**Apni machine pe yeh command run karo (VPS pe nahi):**
```bash
# tradingship-ccxt.tar.gz apni machine pe download karo (Replit se)
# phir VPS pe upload karo:

scp tradingship-ccxt.tar.gz root@YOUR_VPS_IP:/root/
```

**VPS pe wapas aao aur extract karo:**
```bash
cd /root
tar -xzf tradingship-ccxt.tar.gz
mv trading_app tradingship
ls tradingship/   # artifacts/ lib/ scripts/ package.json etc. dikhna chahiye
```

---

## STEP 6 — .env file banao (CRITICAL)

```bash
cat > /root/tradingship/.env << 'EOF'
NODE_ENV=production
PORT=5000

# PostgreSQL connection (Step 4 mein jo password set kiya tha woh daalo)
DATABASE_URL=postgresql://tradingship:StrongPassword123!@localhost:5432/tradingship

# Session secret (64+ random characters — change this!)
SESSION_SECRET=change_this_to_a_very_long_random_secret_at_least_64_characters_long_xyz123

# ============================================================
# OPTIONAL: Exchange API keys
# Binance + Bybit ke liye API key daalne par VPS IP block
# bypass ho jata hai aur WS stream seedha connect hota hai
# ============================================================

# Binance — read-only key (WS ki zaroorat ke liye sirf read permission)
# BINANCE_API_KEY=your_binance_api_key_here

# Bybit — read-only key
# BYBIT_API_KEY=your_bybit_api_key_here
# BYBIT_API_SECRET=your_bybit_api_secret_here

# CoinSwitch (optional — for instrument/leverage data)
# COINSWITCH_API_KEY=your_coinswitch_key
# COINSWITCH_API_SECRET=your_coinswitch_secret
EOF

# Permissions secure karo
chmod 600 /root/tradingship/.env
```

---

## STEP 7 — Dependencies install karo

```bash
cd /root/tradingship

# Install all workspace packages
pnpm install --frozen-lockfile

# Verify CCXT installed
ls node_modules/ccxt/   # should show files
```

---

## STEP 8 — Database schema push karo

```bash
cd /root/tradingship

# .env load karke DB schema push karo
export $(cat .env | grep -v '#' | xargs)
pnpm --filter @workspace/db run push

# Expected output: "Changes applied"
```

---

## STEP 9 — App build karo

```bash
cd /root/tradingship

# TypeScript → JavaScript compile
pnpm --filter @workspace/api-server run build

# Verify build output
ls -lh artifacts/api-server/dist/
# Should see: index.mjs (2-3 MB)
```

---

## STEP 10 — PM2 se start karo

```bash
cd /root/tradingship

# Start the app
pm2 start ecosystem.config.cjs

# Status check
pm2 status
# Should show: tradingship | online | 0%cpu | ~200MB

# Live logs dekho (Ctrl+C se bahar aao)
pm2 logs tradingship --lines 50
```

**Logs mein yeh dikhna chahiye (sab CCXT Pro connected):**
```
INFO: ccxt spot markets loaded  exchange: "kucoin"  count: 948
INFO: ccxt spot markets loaded  exchange: "binance" count: 722
INFO: ccxt spot markets loaded  exchange: "bybit"   count: 536
INFO: ccxt spot markets loaded  exchange: "bitget"  count: 636
INFO: ccxt spot bybit starting watchBidsAsks chunks  chunks: 11
INFO: ccxt spot starting chunked watchTickers  exchange: "bitget"  chunks: 7
INFO: aster bookTicker WS connected
INFO: aster markPrice WS connected
INFO: pi42 Socket.IO connected
INFO: delta ticker WS connected
INFO: Server listening  port: 5000
```

---

## STEP 11 — VPS reboot pe auto-start

```bash
# PM2 ko startup pe register karo
pm2 save
pm2 startup

# Ek command print hogi jaise:
# sudo env PATH=... pm2 startup systemd -u root --hp /root
# Woh command run karo (copy-paste karke)
```

---

## STEP 12 — API test karo

```bash
# Health check
curl http://localhost:5000/api/healthz
# Expected: {"status":"ok"}

# Live status
curl http://localhost:5000/api/spot/status
# Expected: exchanges array with kucoin/bitget online, opportunities count

# Opportunities
curl "http://localhost:5000/api/spot/opportunities?minDiff=0.5" | head -c 500
```

---

## STEP 13 — Nginx setup (Domain ke liye — optional but recommended)

```bash
# Install Nginx
apt install -y nginx

# Config file banao
cat > /etc/nginx/sites-available/tradingship << 'EOF'
server {
    listen 80;
    server_name tradingship.online www.tradingship.online;

    location /api {
        proxy_pass         http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # Agar frontend build hai to yahan serve karo
    # location / {
    #     root /root/tradingship/artifacts/dex-dashboard/dist;
    #     try_files $uri $uri/ /index.html;
    # }
}
EOF

# Enable + test + start
ln -sf /etc/nginx/sites-available/tradingship /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## STEP 14 — SSL (HTTPS) — optional

```bash
# Certbot install
apt install -y certbot python3-certbot-nginx

# Certificate lo (domain already VPS IP pe point karna chahiye)
certbot --nginx -d tradingship.online -d www.tradingship.online

# Auto-renew enable
systemctl enable certbot.timer
```

---

## DAILY USE COMMANDS

```bash
# App status dekho
pm2 status

# Live logs
pm2 logs tradingship

# App restart
pm2 restart tradingship

# Code update ke baad
cd /root/tradingship
git pull   # ya nayi tar.gz upload karo
pnpm install --frozen-lockfile   # agar dependencies badli hain
pnpm --filter @workspace/api-server run build
pm2 restart tradingship

# App band karo
pm2 stop tradingship

# App hamesha ke liye hatao
pm2 delete tradingship
```

---

## TROUBLESHOOTING

### Binance offline dikhta hai?
```bash
# Binance WS VPS IP se kaam karta hai API key ke saath
# .env mein yeh add karo:
BINANCE_API_KEY=your_read_only_binance_key
# Phir restart karo: pm2 restart tradingship
```

### Bybit offline dikhta hai?
```bash
# Bybit API key se IP restriction bypass hoti hai
# .env mein yeh add karo:
BYBIT_API_KEY=your_bybit_key
BYBIT_API_SECRET=your_bybit_secret
# Phir restart karo: pm2 restart tradingship
```

### "PORT already in use" error?
```bash
ss -tlnp | grep 5000   # kya chal raha hai port 5000 pe
pm2 list               # existing processes
pm2 delete all         # sab band karo
pm2 start ecosystem.config.cjs   # fresh start
```

### Database connection fail?
```bash
# .env mein DATABASE_URL check karo
cat /root/tradingship/.env | grep DATABASE_URL

# PostgreSQL running hai?
systemctl status postgresql

# Manual connection test
psql "postgresql://tradingship:StrongPassword123!@localhost:5432/tradingship" -c "SELECT 1;"
```

### "pnpm: command not found" after reboot?
```bash
source ~/.bashrc
nvm use 20
which pnpm   # should print path now
```

---

## EXCHANGE STATUS — Kya expect karo

| Exchange | VPS pe (with API key) | VPS pe (no API key) | Replit pe |
|---|---|---|---|
| **Binance** | ✅ ONLINE | ❌ IP blocked | ❌ IP blocked |
| **KuCoin** | ✅ ONLINE | ✅ ONLINE | ✅ ONLINE |
| **Bybit** | ✅ ONLINE | ⚠️ may work | ❌ slow |
| **Bitget** | ✅ ONLINE | ✅ ONLINE | ✅ ONLINE |

**Recommended:** VPS pe API keys zaroor daalo — Binance + Bybit ONLINE hone par 4x zyada opportunities milenge.

---

## FILES CHANGED (Audit Summary)

```
artifacts/api-server/src/lib/spot-scanner/adapters/ccxt-spot-adapter.ts  ← NEW (CCXT Pro)
artifacts/api-server/src/lib/spot-scanner/index.ts                        ← CCXT import
artifacts/api-server/build.mjs                                             ← ccxt externalized
artifacts/api-server/package.json                                          ← ccxt ^4.4.0 added
artifacts/api-server/src/routes/health.ts                                  ← /api/ status page

# All other files UNCHANGED:
artifacts/api-server/src/lib/spot-scanner/adapters/binance.ts  ← backup (not used)
artifacts/api-server/src/lib/spot-scanner/adapters/bybit.ts    ← backup (not used)
artifacts/api-server/src/lib/spot-scanner/adapters/kucoin.ts   ← backup (not used)
artifacts/api-server/src/lib/spot-scanner/adapters/bitget.ts   ← backup (not used)
artifacts/api-server/src/app.ts                                ← unchanged
artifacts/api-server/src/routes/*.ts (except health.ts)       ← unchanged
artifacts/api-server/src/lib/scanner/                          ← unchanged
artifacts/api-server/src/lib/trading/                          ← unchanged
artifacts/api-server/src/lib/telegram/                         ← unchanged
```
