import { Router, type IRouter, type Request, type Response } from "express";
import {
  startHedgeBot,
  stopHedgeBot,
  getHedgeBotState,
  getLiveSpread,
} from "../lib/spot-hedge/bot.js";
import type { HedgeConfig, HedgeExchange } from "../lib/spot-hedge/types.js";

const VALID_EXCHANGES: HedgeExchange[] = ["binance", "bybit", "kucoin", "bitget"];

const router: IRouter = Router();

// GET /api/spot-hedge/state
router.get("/spot-hedge/state", (_req: Request, res: Response): void => {
  res.json(getHedgeBotState());
});

// GET /api/spot-hedge/quotes?token=GOD&exchangeA=binance&exchangeB=kucoin
router.get("/spot-hedge/quotes", (req: Request, res: Response): void => {
  const { token, exchangeA, exchangeB } = req.query as Record<string, string>;
  if (!token || !exchangeA || !exchangeB) {
    res.status(400).json({ error: "token, exchangeA, exchangeB are required" });
    return;
  }
  if (!VALID_EXCHANGES.includes(exchangeA as HedgeExchange) || !VALID_EXCHANGES.includes(exchangeB as HedgeExchange)) {
    res.status(400).json({ error: "Invalid exchange name" });
    return;
  }
  if (exchangeA === exchangeB) {
    res.status(400).json({ error: "exchangeA and exchangeB must be different" });
    return;
  }
  const tdsPct        = parseFloat((req.query["tdsPct"] as string) || "1");
  const takerFeePct   = parseFloat((req.query["takerFeePct"] as string) || "0.1");
  const gstPct        = parseFloat((req.query["gstPct"] as string) || "18");
  const tradeAmtUsdt  = parseFloat((req.query["tradeAmountUsdt"] as string) || "100");

  const spread = getLiveSpread(
    token.toUpperCase(),
    exchangeA as HedgeExchange,
    exchangeB as HedgeExchange,
    { tdsPct, takerFeePct, gstPct, tradeAmountUsdt: tradeAmtUsdt },
  );
  res.json(spread);
});

// POST /api/spot-hedge/start
router.post("/spot-hedge/start", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<HedgeConfig>;

  const config: HedgeConfig = {
    token:               (body.token ?? "").toUpperCase().trim(),
    exchangeA:           body.exchangeA ?? "binance",
    exchangeB:           body.exchangeB ?? "kucoin",
    tradeAmountUsdt:     Number(body.tradeAmountUsdt)     || 100,
    minSpreadPct:        Number(body.minSpreadPct)        || 0.5,
    neutralThresholdPct: Number(body.neutralThresholdPct) || 1.5,
    maxRounds:           Number(body.maxRounds)           || 1,
    flipIntervalSec:     body.flipIntervalSec != null ? Number(body.flipIntervalSec) : 5,
    tdsPct:              body.tdsPct          != null ? Number(body.tdsPct)          : 1,
    takerFeePct:         Number(body.takerFeePct)         || 0.1,
    gstPct:              body.gstPct          != null ? Number(body.gstPct)          : 18,
    dryRun:              body.dryRun !== false,            // default true (safe)
    maxLossUsdt:         body.maxLossUsdt != null ? Number(body.maxLossUsdt) : undefined,
  };

  if (!config.token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  if (!VALID_EXCHANGES.includes(config.exchangeA) || !VALID_EXCHANGES.includes(config.exchangeB)) {
    res.status(400).json({ error: "Invalid exchange name" });
    return;
  }
  if (config.exchangeA === config.exchangeB) {
    res.status(400).json({ error: "exchangeA and exchangeB must be different" });
    return;
  }
  if (config.tradeAmountUsdt < 5) {
    res.status(400).json({ error: "tradeAmountUsdt must be at least 5 USDT" });
    return;
  }
  if (config.minSpreadPct <= 0) {
    res.status(400).json({ error: "minSpreadPct must be greater than 0" });
    return;
  }
  if (config.neutralThresholdPct < 0) {
    res.status(400).json({ error: "neutralThresholdPct must be >= 0" });
    return;
  }
  if (config.tdsPct < 0 || config.tdsPct > 100) {
    res.status(400).json({ error: "tdsPct must be between 0 and 100" });
    return;
  }
  if (config.takerFeePct < 0 || config.takerFeePct > 10) {
    res.status(400).json({ error: "takerFeePct must be between 0 and 10" });
    return;
  }

  const result = await startHedgeBot(config);
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ ok: true, message: "Bot started", config });
});

// POST /api/spot-hedge/stop  { force?: boolean }
router.post("/spot-hedge/stop", (req: Request, res: Response): void => {
  const force = Boolean((req.body as { force?: boolean }).force);
  const result = stopHedgeBot(force);
  res.json({ ok: result.ok, message: force ? "Force stopped" : "Graceful exit initiated" });
});

// GET /api/spot-hedge/trades — just the trades array from state
router.get("/spot-hedge/trades", (_req: Request, res: Response): void => {
  const state = getHedgeBotState();
  res.json(state.trades);
});

export default router;
