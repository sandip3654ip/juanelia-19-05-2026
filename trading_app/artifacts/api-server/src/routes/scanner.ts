import { Router, type IRouter } from "express";
import { scanner } from "../lib/scanner";
import {
  GetScannerStatusResponse,
  GetOpportunitiesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/scanner/status", async (req, res): Promise<void> => {
  const statuses = scanner.getExchangeStatuses();

  const payload = {
    running: scanner.running,
    exchanges: statuses,
    opportunityCount: scanner.opportunities.length,
    lastUpdatedAt: scanner.lastUpdatedAt,
  };

  const parsed = GetScannerStatusResponse.safeParse(payload);
  if (!parsed.success) {
    req.log.error({ errors: parsed.error.message }, "scanner status parse error");
    res.status(500).json({ error: "Internal error" });
    return;
  }

  res.set("Cache-Control", "no-store");
  res.json(parsed.data);
});

router.get("/scanner/price-history", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(scanner.getPriceHistory());
});

router.get("/scanner/price-movements", (_req, res): void => {
  res.set("Cache-Control", "no-store");
  res.json(scanner.getPriceMovements());
});

router.get("/scanner/opportunities", async (req, res): Promise<void> => {
  const lastUpdated = scanner.lastUpdatedAt;

  // Parse optional targetedSpread query param (percentage → decimal)
  const targetedSpreadPct = parseFloat(req.query["targetedSpread"] as string);
  const targetedSpreadDecimal = isFinite(targetedSpreadPct) ? targetedSpreadPct / 100 : Infinity;

  // ETag includes targetedSpread so different thresholds get fresh responses
  const etag = `"opps-${lastUpdated}-${isFinite(targetedSpreadDecimal) ? targetedSpreadPct : "all"}"`;
  if (req.headers["if-none-match"] === etag) {
    res.set("Cache-Control", "no-store");
    res.set("ETag", etag);
    res.status(304).end();
    return;
  }

  const opps = scanner.opportunitiesWithTarget(targetedSpreadDecimal);
  const parsed = GetOpportunitiesResponse.safeParse(opps);
  if (!parsed.success) {
    req.log.error(
      { errors: parsed.error.message },
      "opportunities parse error",
    );
    res.status(500).json({ error: "Internal error" });
    return;
  }

  res.set("Cache-Control", "no-store");
  res.set("ETag", etag);
  res.json(parsed.data);
});

export default router;
