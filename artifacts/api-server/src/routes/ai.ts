import { Router, type IRouter, type Request, type Response } from "express";
import {
  checkOllamaStatus,
  analyzeToken,
  scanAllOpportunities,
  getCachedScores,
  getCachedScore,
} from "../lib/ai-market/index.js";

const router: IRouter = Router();

// GET /api/ai/status — check if Ollama is reachable
router.get("/ai/status", async (_req: Request, res: Response): Promise<void> => {
  const status = await checkOllamaStatus();
  res.set("Cache-Control", "no-store");
  res.json(status);
});

// GET /api/ai/scores — all cached AI scores (sorted by score desc)
router.get("/ai/scores", (_req: Request, res: Response): void => {
  res.set("Cache-Control", "no-store");
  res.json(getCachedScores());
});

// GET /api/ai/scores/:token — single token cached score
router.get("/ai/scores/:token", (req: Request, res: Response): void => {
  const token = (req.params["token"] ?? "").toUpperCase();
  const score = getCachedScore(token);
  if (!score) {
    res.status(404).json({ error: `No AI score found for ${token}. Call POST /api/ai/analyze first.` });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json(score);
});

// POST /api/ai/analyze — analyze a single token
// Body: { token: "BTC", buyExchange?: "binance", sellExchange?: "bybit", forceRefresh?: true }
router.post("/ai/analyze", async (req: Request, res: Response): Promise<void> => {
  const { token, buyExchange, sellExchange, forceRefresh } = req.body as {
    token?: string;
    buyExchange?: string;
    sellExchange?: string;
    forceRefresh?: boolean;
  };

  if (!token?.trim()) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  try {
    const result = await analyzeToken(
      token.trim().toUpperCase(),
      buyExchange ?? "binance",
      sellExchange ?? "bybit",
      forceRefresh ?? false,
    );
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

// POST /api/ai/scan — scan top N opportunities from spot scanner
// Body: { limit?: 10 }
router.post("/ai/scan", async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(Number((req.body as { limit?: number }).limit) || 10, 25);

  try {
    const results = await scanAllOpportunities(limit);
    res.json({ count: results.length, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

export default router;
