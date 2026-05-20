# TradingShip VPS Deployment Guide
# tradingship.online — WebSocket Fix + Full Setup

## PROBLEMS FIXED IN THIS VERSION

### 1. Binance WS — Pong Timeout Bug (CRITICAL)
**Old behavior**: When pong wasn't received, timer just set itself to `null` — zombie
connection was NEVER detected. Server kept sending data to a dead connection.
**Fixed**: Pong timeout now immediately terminates + reconnects.

### 2. Binance WS — Permanent REST Fallback (CRITICAL)
**Old behavior**: After 5 WS failures → REST mode — NEVER tried WS again.
**Fixed**: REST mode now retries WS every 5 minutes automatically.

### 3. Bybit, Bitget, KuCoin, Kraken — No Silence Watchdog (CRITICAL)
**Old behavior**: On VPS, NAT tables expire in 60-300s. TCP appears open but is dead.
`close` event never fires. Adapter thinks data is flowing but WS is silent.
**Fixed**: 60s silence watchdog added. Any message resets it. Timeout = reconnect.

### 4. Aster — Pong Handler Missing (BUG)
**Old behavior**: `ws.on("pong")` was never registered — pong events silently dropped.
**Fixed**: Pong handlers added + silence watchdog added.

### 5. TCP Keepalive — All Adapters
**Old behavior**: No OS-level keepalive — dead connections not detected at kernel level.
**Fixed**: `socket.setKeepAlive(true, 30000)` on every WS connection open.

---

## STEP 1 — SSH INTO YOUR VPS

```bash
ssh root@your-vps-ip
```

---

## STEP 2 — INSTALL DEPENDENCIES (if not already done)

```bash
# Node.js 20+ via NVM (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node --version  # should show v20.x

# pnpm
npm install -g pnpm
pnpm --version

# PM2 (process manager)
npm install -g pm2
pm2 --version

# PM2 log rotation (optional but recommended)
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 7
```

---

## STEP 3 — UPLOAD YOUR CODE TO VPS

**Option A — Git pull (if you have the code in git):**
```bash
cd /root
git clone https://github.com/sandip3654ip/Sandip36543654.git money-machine-tradingship
cd money-machine-tradingship
# Extract the tar.gz
tar -xzf "money-machine-tradingship (2).tar.gz" --strip-components=1
```

**Option B — SCP from your local machine:**
```bash
# Run this on your LOCAL machine:
scp -r /path/to/your/app root@your-vps-ip:/root/money-machine-tradingship
```

---

## STEP 4 — COPY FIXED WS FILES (THE CRITICAL FIXES)

After uploading, replace the broken WebSocket adapter files with the fixed ones.
Upload the fixed files from this directory to your VPS:

```bash
# On VPS — navigate to your app
cd /root/money-machine-tradingship

# The fixed files are in:
# artifacts/api-server/src/lib/spot-scanner/adapters/binance.ts  ← CRITICAL FIX
# artifacts/api-server/src/lib/spot-scanner/adapters/bybit.ts    ← CRITICAL FIX
# artifacts/api-server/src/lib/spot-scanner/adapters/bitget.ts   ← CRITICAL FIX
# artifacts/api-server/src/lib/spot-scanner/adapters/kucoin.ts   ← CRITICAL FIX
# artifacts/api-server/src/lib/spot-scanner/adapters/kraken.ts   ← CRITICAL FIX
# artifacts/api-server/src/lib/scanner/aster-ws.ts               ← CRITICAL FIX
```

---

## STEP 5 — CONFIGURE ENVIRONMENT VARIABLES

```bash
# Create the .env file (or set in ecosystem.config.cjs)
cat > /root/money-machine-tradingship/.env << 'EOF'
NODE_ENV=production
PORT=5000
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/tradingship
SESSION_SECRET=change_this_to_a_very_long_random_secret_string_at_least_64_chars

# STRONGLY RECOMMENDED — API keys bypass VPS IP blocks:
# Without these, Binance/Bybit may block your VPS IP with 403 errors

# Binance (read-only key — bypasses IP rate limits on VPS)
BINANCE_API_KEY=your_binance_read_only_api_key

# Bybit (read-only key — bypasses 403 IP block on VPS without key)
BYBIT_API_KEY=your_bybit_api_key
BYBIT_API_SECRET=your_bybit_api_secret

# CoinSwitch (optional — for instrument info / leverage data)
# COINSWITCH_API_KEY=your_coinswitch_api_key
# COINSWITCH_API_SECRET=your_coinswitch_api_secret
EOF

chmod 600 /root/money-machine-tradingship/.env
```

---

## STEP 6 — INSTALL PACKAGES

```bash
cd /root/money-machine-tradingship

# Install all dependencies
pnpm install --frozen-lockfile
```

---

## STEP 7 — SET UP DATABASE

```bash
# Install PostgreSQL if not already installed
apt update && apt install -y postgresql postgresql-contrib

# Start PostgreSQL
systemctl start postgresql
systemctl enable postgresql

# Create database and user
sudo -u postgres psql << 'EOF'
CREATE USER tradingship WITH PASSWORD 'yourpassword';
CREATE DATABASE tradingship OWNER tradingship;
GRANT ALL PRIVILEGES ON DATABASE tradingship TO tradingship;
EOF

# Update DATABASE_URL in .env to match:
# DATABASE_URL=postgresql://tradingship:yourpassword@localhost:5432/tradingship

# Run DB migrations
pnpm --filter @workspace/db run push
```

---

## STEP 8 — BUILD THE APP

```bash
cd /root/money-machine-tradingship

# Build the API server (TypeScript → JavaScript)
pnpm --filter @workspace/api-server run build

# Verify the build output exists
ls -la artifacts/api-server/dist/
# Should see: index.mjs
```

---

## STEP 9 — CREATE LOG DIRECTORY

```bash
mkdir -p /var/log/tradingship
```

---

## STEP 10 — START WITH PM2

```bash
cd /root/money-machine-tradingship

# Start the app
pm2 start ecosystem.config.cjs

# Check it's running
pm2 status

# View logs (live)
pm2 logs tradingship

# Save PM2 config so it restarts after VPS reboot
pm2 save
pm2 startup  # Follow the printed command to enable startup
```

---

## STEP 11 — SET UP NGINX (Reverse Proxy)

```bash
# Install Nginx
apt install -y nginx

# Create Nginx config for tradingship.online
cat > /etc/nginx/sites-available/tradingship.online << 'EOF'
server {
    listen 80;
    server_name tradingship.online www.tradingship.online;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tradingship.online www.tradingship.online;

    ssl_certificate     /etc/letsencrypt/live/tradingship.online/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tradingship.online/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;

    # Proxy API + WebSocket to Node.js
    location /api {
        proxy_pass         http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;  # Keep WS connections open (24h)
        proxy_send_timeout 86400;
    }

    # Serve frontend static files
    location / {
        root /root/money-machine-tradingship/artifacts/dex-dashboard/dist;
        try_files $uri $uri/ /index.html;
        expires 1h;
        add_header Cache-Control "public, no-transform";
    }
}
EOF

# Enable the site
ln -sf /etc/nginx/sites-available/tradingship.online /etc/nginx/sites-enabled/
nginx -t  # Test config
systemctl reload nginx
```

---

## STEP 12 — SSL CERTIFICATE (Let's Encrypt)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d tradingship.online -d www.tradingship.online
# Auto-renew
systemctl enable certbot.timer
```

---

## STEP 13 — BUILD FRONTEND

```bash
cd /root/money-machine-tradingship

# Build the dashboard frontend
pnpm --filter @workspace/dex-dashboard run build

# Verify output
ls -la artifacts/dex-dashboard/dist/
```

---

## STEP 14 — VERIFY EVERYTHING IS WORKING

```bash
# Check API is alive
curl http://localhost:5000/api/health

# Check PM2 status
pm2 status

# Watch live logs for WS connections
pm2 logs tradingship --lines 100

# What you SHOULD see in logs:
# "binance spot combined-stream WS connected"
# "bybit spot WS connected"
# "bitget spot WS connected"
# "kucoin spot WS connected"
# "kraken spot WS connected"
# "aster bookTicker WS connected"
# "aster markPrice WS connected"

# What you should NOT see (old behavior, now fixed):
# "WS too many failures — falling back to REST"  (stays there forever)
# No reconnect after silence
```

---

## QUICK DEPLOY COMMANDS (After First Setup)

When you update code:
```bash
cd /root/money-machine-tradingship
git pull  # or scp your updated files

# Rebuild
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/dex-dashboard run build

# Reload without downtime
pm2 reload tradingship

# Check logs
pm2 logs tradingship --lines 50
```

---

## TROUBLESHOOTING

### WebSocket still dying?
```bash
# Check if Binance is blocking your VPS IP
curl "https://data-api.binance.vision/api/v3/ping"
# Should return: {}

# Check WS connection status in logs
pm2 logs tradingship | grep -E "WS connected|WS closed|WS error|fallback|silent"

# Add API keys to .env for better reliability:
# BINANCE_API_KEY, BYBIT_API_KEY, BYBIT_API_SECRET
```

### App crashes on start?
```bash
pm2 logs tradingship --err --lines 50
# Check DATABASE_URL is correct
# Check PORT is not already in use: ss -tlnp | grep 5000
```

### NAT/Firewall issues?
```bash
# Open required outbound ports (most VPS allow by default):
# 443 (WSS to Binance, Bybit, Bitget, KuCoin, Kraken, Aster, Delta)
# 80  (REST APIs)
# Check with: curl -v wss://stream.bybit.com/v5/public/spot
```

### Nginx 502 Bad Gateway?
```bash
# Make sure Node.js is running on port 5000
curl http://localhost:5000/api/health
pm2 status
pm2 restart tradingship
```
