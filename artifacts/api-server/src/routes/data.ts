/**
 * Data management routes — reset stored data stores.
 *
 * POST /api/data/reset
 *   Clears all in-memory and on-disk data stores:
 *     - Funding arb price history  (data/price-history.json)
 *     - Spot price history         (data/spot-price-history.json)
 *     - Spread history             (data/spread-history.json)
 *     - Spot profit history        (data/spot-profit-history.json)
 *   Returns { ok: true, cleared: string[] }
 *
 * GET /api/data/stats
 *   Returns sizes of all in-memory stores (useful for monitoring server load).
 */

import { Router, type IRouter } from "express";
import { priceHistory } from "../lib/scanner/price-history.js";
import * as spreadHistory from "../lib/scanner/spread-history.js";
import { spotPriceHistory } from "../lib/spot-scanner/price-history.js";
import { spotProfitHistory } from "../lib/spot-scanner/profit-history.js";
import { resetAllConfirmedCounts } from "../lib/spot-scanner/fees/deposit-address-service.js";

const router: IRouter = Router();

router.post("/data/reset", (req, res): void => {
  const cleared: string[] = [];

  try {
    priceHistory.clearAll();
    cleared.push("price-history");
  } catch (err) {
    req.log.error({ err }, "data reset: price-history clear failed");
  }

  try {
    spreadHistory.clearAll();
    cleared.push("spread-history");
  } catch (err) {
    req.log.error({ err }, "data reset: spread-history clear failed");
  }

  try {
    spotPriceHistory.clearAll();
    cleared.push("spot-price-history");
  } catch (err) {
    req.log.error({ err }, "data reset: spot-price-history clear failed");
  }

  try {
    spotProfitHistory.clearAll();
    cleared.push("spot-profit-history");
  } catch (err) {
    req.log.error({ err }, "data reset: spot-profit-history clear failed");
  }

  try {
    const n = resetAllConfirmedCounts();
    cleared.push(`deposit-address-confirmed-counts(${n})`);
  } catch (err) {
    req.log.error({ err }, "data reset: deposit address confirmedCount reset failed");
  }

  req.log.info({ cleared }, "data reset complete");
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, cleared });
});

router.get("/data/stats", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json({
    priceHistory:     { symbols: priceHistory.symbolCount },
    spreadHistory:    { pairs:   spreadHistory.pairCount() },
    spotProfitHistory:{ keys:    spotProfitHistory.keyCount },
    spotPriceHistory: { rows:    spotPriceHistory.rowCount, symbols: spotPriceHistory.symbolCount },
  });
});

export default router;
