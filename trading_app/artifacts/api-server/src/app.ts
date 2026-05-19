import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { scanner } from "./lib/scanner";
import { spotScanner } from "./lib/spot-scanner/index.js";
import { startWalletRefreshLoop } from "./lib/wallet/index.js";
import { startAlertLoop } from "./lib/telegram/alert-service.js";
import { routeCache, startRouteCachePruner } from "./lib/route-cache.js";
import { startBotLoop } from "./lib/bot/bot-engine.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Per-route response cache (pure infrastructure — no logic change) ──────────
// Serves a cached JSON body for GET requests within each TTL window.
// Prevents redundant computation when multiple tabs poll simultaneously.
// Funding arb data is now pushed via WS (/api/ws) every 500 ms.
// These HTTP routes remain as fallback for non-WS clients / initial load.
app.get("/api/scanner/opportunities", routeCache(300));  // WS fallback
app.get("/api/spot/opportunities",    routeCache(300));  // polled at 500 ms
app.get("/api/scanner/status",        routeCache(400));  // WS fallback
app.get("/api/spot/status",           routeCache(400));  // polled at 500 ms
app.get("/api/markets",               routeCache(400));  // WS fallback
app.get("/api/wallet/balances",       routeCache(2_000)); // polled every 3–5 s
app.get("/api/spot/price-movements",  routeCache(29_000)); // data changes every 30 s
app.get("/api/spot/sparklines",       routeCache(29_000)); // data changes every 30 s
app.get("/api/scanner/price-movements", routeCache(55_000)); // data changes every 60 s
app.get("/api/scanner/price-history",  routeCache(55_000)); // data changes every 60 s

app.use("/api", router);

// ── 404 — unknown /api routes ──────────────────────────────────────────────
app.use("/api", (_req: Request, res: Response): void => {
  res.status(404).json({ error: "Not found" });
});

// ── Global error handler — catches any next(err) or thrown errors ──────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const message = err instanceof Error ? err.message : String(err);
  req.log.error({ err }, "unhandled route error");
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error", detail: message });
  }
});

// Start route-cache pruner (clears expired entries every 30 s)
startRouteCachePruner();

// Start the arbitrage scanner
scanner.start();
logger.info("arbitrage scanner started");

// Start the spot arbitrage scanner
spotScanner.start();

// Start wallet balance background refresh (every 3 s, all exchanges in parallel)
startWalletRefreshLoop();

// Start Telegram alert loop (checks spot opportunities every 30 s)
startAlertLoop();

// Start trading bot loop (runs every 1 s; disabled by default)
startBotLoop();

export default app;
