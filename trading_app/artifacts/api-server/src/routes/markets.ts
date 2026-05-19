import { Router, type IRouter } from "express";
import { scanner } from "../lib/scanner";
import { GetMarketsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/markets", async (req, res): Promise<void> => {
  const markets = scanner.getMarkets();

  const toMarketTick = (tick: {
    exchange: string;
    symbol: string;
    bestBid: number;
    bestAsk: number;
    fundingRate: number;
    fundingIntervalMs: number;
    nextFundingAt: number;
    receivedAt: number;
  }) => {
    const mid = (tick.bestBid + tick.bestAsk) / 2;
    const spreadPct = mid > 0 ? ((tick.bestAsk - tick.bestBid) / mid) * 100 : 0;
    return {
      symbol: tick.symbol,
      exchange: tick.exchange,
      bestBid: tick.bestBid,
      bestAsk: tick.bestAsk,
      markPrice: null,
      fundingRate: tick.fundingRate,
      fundingIntervalMs: tick.fundingIntervalMs,
      nextFundingAt: tick.nextFundingAt,
      spreadPct: Math.round(spreadPct * 10000) / 10000,
      receivedAt: tick.receivedAt,
    };
  };

  const payload = {
    pi42: markets.pi42.map(toMarketTick),
    aster: markets.aster.map(toMarketTick),
    delta: markets.delta.map(toMarketTick),
    coinswitch: markets.coinswitch.map(toMarketTick),
  };

  const parsed = GetMarketsResponse.safeParse(payload);
  if (!parsed.success) {
    req.log.error({ errors: parsed.error.message }, "markets parse error");
    res.status(500).json({ error: "Internal error" });
    return;
  }

  res.set("Cache-Control", "no-store");
  res.json(parsed.data);
});

export default router;
