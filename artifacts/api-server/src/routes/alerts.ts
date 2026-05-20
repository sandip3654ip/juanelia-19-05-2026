import { Router, type IRouter } from "express";
import {
  getConfig,
  updateConfig,
  getHistory,
  sendTestAlert,
  detectAndSaveChatId,
} from "../lib/telegram/alert-service.js";

const router: IRouter = Router();

// GET /api/alerts/config
router.get("/alerts/config", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(getConfig());
});

// PUT /api/alerts/config
router.put("/alerts/config", (req, res): void => {
  const { enabled, minNetProfitPct, minTimesHit, cooldownMinutes, maxPriceMovementPct, priceMovementPeriodMs } = req.body as {
    enabled?:               boolean;
    minNetProfitPct?:       number;
    minTimesHit?:           number;
    cooldownMinutes?:       number;
    maxPriceMovementPct?:   number | null;
    priceMovementPeriodMs?: number;
  };

  const patch: Parameters<typeof updateConfig>[0] = {};

  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    patch.enabled = enabled;
  }

  if (minNetProfitPct !== undefined) {
    if (typeof minNetProfitPct !== "number" || !isFinite(minNetProfitPct)) {
      res.status(400).json({ error: "minNetProfitPct must be a finite number" });
      return;
    }
    patch.minNetProfitPct = minNetProfitPct;
  }

  if (minTimesHit !== undefined) {
    if (typeof minTimesHit !== "number" || !Number.isInteger(minTimesHit) || minTimesHit < 0) {
      res.status(400).json({ error: "minTimesHit must be a non-negative integer" });
      return;
    }
    patch.minTimesHit = minTimesHit;
  }

  if (cooldownMinutes !== undefined) {
    if (typeof cooldownMinutes !== "number" || cooldownMinutes < 0.1 || cooldownMinutes > 1440) {
      res.status(400).json({ error: "cooldownMinutes must be a number between 0.1 and 1440" });
      return;
    }
    patch.cooldownMinutes = cooldownMinutes;
  }

  if (maxPriceMovementPct !== undefined) {
    if (maxPriceMovementPct !== null && (typeof maxPriceMovementPct !== "number" || !isFinite(maxPriceMovementPct) || maxPriceMovementPct <= 0)) {
      res.status(400).json({ error: "maxPriceMovementPct must be null or a positive finite number" });
      return;
    }
    patch.maxPriceMovementPct = maxPriceMovementPct;
  }

  if (priceMovementPeriodMs !== undefined) {
    const VALID_PERIODS = [4 * 3_600_000, 8 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];
    if (!VALID_PERIODS.includes(priceMovementPeriodMs)) {
      res.status(400).json({ error: `priceMovementPeriodMs must be one of: ${VALID_PERIODS.join(", ")}` });
      return;
    }
    patch.priceMovementPeriodMs = priceMovementPeriodMs;
  }

  res.set("Cache-Control", "no-store");
  res.json(updateConfig(patch));
});

// GET /api/alerts/history
router.get("/alerts/history", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(getHistory());
});

// POST /api/alerts/test
router.post("/alerts/test", async (_req, res): Promise<void> => {
  const result = await sendTestAlert();
  res.set("Cache-Control", "no-store");
  res.status(result.ok ? 200 : 502).json(result);
});

// POST /api/alerts/detect-chat-id
router.post("/alerts/detect-chat-id", async (_req, res): Promise<void> => {
  const result = await detectAndSaveChatId();
  res.set("Cache-Control", "no-store");
  res.status(result.ok ? 200 : 422).json(result);
});

export default router;
