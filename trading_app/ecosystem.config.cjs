module.exports = {
  apps: [{
    name: "tradingship",
    script: "./artifacts/api-server/dist/index.mjs",
    cwd: "/root/juanelia-19-05-2026/trading_app",
    node_args: "--enable-source-maps",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    max_memory_restart: "1500M",
    restart_delay: 3000,
    env: {
      NODE_ENV: "production",
      PORT: "5000",
      REGISTERED_PHONE: "9064954664",
      FAST2SMS_API_KEY: "BG4k5RqOobdz5XnThe8ybCq29mRtfquwhZIY6nV40ZseFTQ3FeUfQ6y4U15b"
    },
    out_file: "/var/log/tradingship/out.log",
    error_file: "/var/log/tradingship/error.log",
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z"
  }]
};
