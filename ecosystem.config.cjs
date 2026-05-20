/**
 * PM2 Ecosystem Config — tradingship.online
 *
 * Start:   pm2 start ecosystem.config.cjs
 * Reload:  pm2 reload tradingship
 * Logs:    pm2 logs tradingship
 * Monitor: pm2 monit
 */
module.exports = {
  apps: [
    {
      name: "tradingship",
      script: "./artifacts/api-server/dist/index.mjs",
      cwd: "/root/money-machine-tradingship",

      // Node.js flags
      node_args: "--enable-source-maps",

      // Number of instances (1 = single process, no clustering needed for WS)
      instances: 1,

      // Auto-restart if app crashes
      autorestart: true,
      watch: false,

      // Restart if memory exceeds 1.5 GB
      max_memory_restart: "1500M",

      // Restart delay after crash (ms)
      restart_delay: 3000,

      // Environment variables — add your API keys here
      env: {
        NODE_ENV: "production",
        PORT: "5000",

        // ── Required ─────────────────────────────────────────────────────────
        // DATABASE_URL: "postgresql://user:pass@localhost:5432/tradingship",

        // ── Optional but STRONGLY recommended for VPS (bypasses IP blocks) ──
        // BINANCE_API_KEY:      "your_binance_read_only_api_key",
        // BYBIT_API_KEY:        "your_bybit_api_key",
        // BYBIT_API_SECRET:     "your_bybit_api_secret",
        // COINSWITCH_API_KEY:   "your_coinswitch_api_key",
        // COINSWITCH_API_SECRET:"your_coinswitch_api_secret",

        // Session secret
        SESSION_SECRET: "CHANGE_THIS_TO_A_LONG_RANDOM_STRING",
      },

      // Log files
      out_file: "/var/log/tradingship/out.log",
      error_file: "/var/log/tradingship/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Keep logs for 7 days (requires pm2-logrotate module)
      max_restarts: 10,
      min_uptime: "10s",
    },
  ],
};
