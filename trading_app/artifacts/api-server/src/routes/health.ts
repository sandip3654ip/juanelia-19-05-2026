import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { spotScanner } from "../lib/spot-scanner/index.js";
import { scanner } from "../lib/scanner/index.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// ── Live status page — shown in Replit preview pane ─────────────────────────

router.get("/", (_req, res) => {
  const spotStatuses  = spotScanner.getStatuses();
  const scanStatuses  = scanner.getExchangeStatuses();
  const spotOpps      = spotScanner.getOpportunities(0).length;
  const scanOpps      = scanner.opportunities.length;

  const dot = (online: boolean) =>
    `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${online ? "#22c55e" : "#ef4444"};margin-right:6px"></span>`;

  const spotRows = spotStatuses.map(e =>
    `<tr>
      <td>${dot(e.status === "online")}${e.exchange}</td>
      <td>${e.status === "online" ? "ONLINE" : "offline"}</td>
      <td>${e.symbolCount ?? 0} symbols</td>
      <td>${e.dataSource ?? "ws"}</td>
    </tr>`
  ).join("");

  const scanRows = scanStatuses.map(e =>
    `<tr>
      <td>${dot(e.status === "online")}${e.exchange}</td>
      <td>${e.status === "online" ? "ONLINE" : e.status}</td>
      <td>${(e as { instrumentCount?: number }).instrumentCount ?? "—"}</td>
      <td>ws</td>
    </tr>`
  ).join("");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="5">
<title>TradingShip — Live Status</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px }
  h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 4px; color: #f8fafc }
  .sub { color: #64748b; font-size: 0.8rem; margin-bottom: 24px }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px }
  .card { background: #1e293b; border-radius: 10px; padding: 16px }
  .card-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 12px }
  .big { font-size: 2.2rem; font-weight: 800; color: #38bdf8 }
  .label { font-size: 0.72rem; color: #94a3b8; margin-top: 2px }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem }
  th { text-align: left; color: #475569; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0 8px 8px 8px }
  td { padding: 6px 8px; border-bottom: 1px solid #0f172a; color: #cbd5e1 }
  .section { background: #1e293b; border-radius: 10px; padding: 16px; margin-bottom: 16px }
  .section-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 12px }
  .links { font-size: 0.72rem; color: #475569; margin-top: 16px }
  .links a { color: #38bdf8; text-decoration: none }
  .links a:hover { text-decoration: underline }
</style>
</head>
<body>
<h1>TradingShip — Live Status</h1>
<div class="sub">Auto-refreshes every 5 seconds &nbsp;·&nbsp; ${new Date().toISOString()}</div>

<div class="grid">
  <div class="card">
    <div class="card-title">Spot Arb Opportunities</div>
    <div class="big">${spotOpps}</div>
    <div class="label">binance · kucoin · bybit · bitget</div>
  </div>
  <div class="card">
    <div class="card-title">Funding Arb Opportunities</div>
    <div class="big">${scanOpps}</div>
    <div class="label">pi42 · aster · delta · coinswitch</div>
  </div>
</div>

<div class="section">
  <div class="section-title">Spot Exchanges (CCXT Pro WebSocket)</div>
  <table>
    <thead><tr><th>Exchange</th><th>Status</th><th>Live Quotes</th><th>Source</th></tr></thead>
    <tbody>${spotRows}</tbody>
  </table>
</div>

<div class="section">
  <div class="section-title">Funding / Futures Exchanges</div>
  <table>
    <thead><tr><th>Exchange</th><th>Status</th><th>Instruments</th><th>Source</th></tr></thead>
    <tbody>${scanRows}</tbody>
  </table>
</div>

<div class="links">
  <a href="/api/healthz">/api/healthz</a> &nbsp;·&nbsp;
  <a href="/api/spot/status">/api/spot/status</a> &nbsp;·&nbsp;
  <a href="/api/spot/opportunities">/api/spot/opportunities</a> &nbsp;·&nbsp;
  <a href="/api/scanner/status">/api/scanner/status</a>
</div>
</body>
</html>`);
});

export default router;
