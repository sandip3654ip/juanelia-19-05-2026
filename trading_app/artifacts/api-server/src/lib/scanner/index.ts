/**
 * Scanner orchestrator
 * Manages all exchange adapters and maintains the aggregated feed state.
 * Provides the single source of truth for opportunities and exchange status.
 */

import { logger } from "../logger";
import { Pi42Adapter } from "./pi42-ws";
import { AsterAdapter } from "./aster-ws";
import { DeltaAdapter } from "./delta-ws";
import { CoinSwitchAdapter } from "./coinswitch-ws";
import { buildOpportunities } from "./aggregator";
import { priceHistory } from "./price-history";
import * as spreadHistory from "./spread-history";
import type { FeedTick, ArbitrageOpportunity, Exchange } from "./aggregator";

export type { ArbitrageOpportunity, FeedTick, Exchange };

interface ExchangeStatusInfo {
  exchange: Exchange;
  status: "online" | "degraded" | "offline";
  lastDataAt: number | null;
  errorMessage: string | null;
  instrumentCount: number;
}

class Scanner {
  private feedState: Map<Exchange, Map<string, FeedTick>> = new Map([
    ["pi42", new Map()],
    ["aster", new Map()],
    ["delta", new Map()],
    ["coinswitch", new Map()],
  ]);

  private pi42: Pi42Adapter;
  private aster: AsterAdapter;
  private delta: DeltaAdapter;
  private coinswitch: CoinSwitchAdapter;

  private _running = false;
  private _opportunities: ArbitrageOpportunity[] = [];
  private _lastUpdatedAt: number | null = null;

  private exchangeLastDataAt: Map<Exchange, number> = new Map();
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private _initTimer:    ReturnType<typeof setTimeout>  | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private spreadTimer:   ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.pi42 = new Pi42Adapter((tick) => this.onTick(tick));
    this.aster = new AsterAdapter((tick) => this.onTick(tick));
    this.delta = new DeltaAdapter((tick) => this.onTick(tick));
    this.coinswitch = new CoinSwitchAdapter((tick) => this.onTick(tick));
  }

  start() {
    if (this._running) return;
    this._running = true;
    logger.info("scanner starting");
    this.pi42.start();
    this.aster.start();
    this.delta.start();
    this.coinswitch.start();

    // Price history: load persisted data from disk, then start snapshotting
    priceHistory.loadFromDisk();
    priceHistory.startPruner();

    // Spread history: load from disk and start persisting every 30s
    spreadHistory.loadFromDisk();
    spreadHistory.startPersist();
    // Delay first snapshot by 10s to let exchange adapters seed initial data,
    // then save to disk immediately so restarts always have a recent baseline.
    this._initTimer = setTimeout(() => {
      this._initTimer = null;
      priceHistory.snapshot(this.feedState);
      priceHistory.saveToDisk();
    }, 10_000);
    this.snapshotTimer = setInterval(() => {
      priceHistory.snapshot(this.feedState);
    }, 15_000);

    // Spread history: record every live opportunity's spread once per second
    this.spreadTimer = setInterval(() => {
      for (const opp of this._opportunities) {
        const key = spreadHistory.makeKey(opp.symbol, opp.longExchange, opp.shortExchange);
        spreadHistory.record(key, opp.spreadPct);
      }
    }, 1_000);

    logger.info("scanner started — all adapters running");
  }

  stop() {
    this._running = false;
    this.pi42.stop();
    this.aster.stop();
    this.delta.stop();
    this.coinswitch.stop();
    if (this._initTimer) {
      clearTimeout(this._initTimer);
      this._initTimer = null;
    }
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.spreadTimer) {
      clearInterval(this.spreadTimer);
      this.spreadTimer = null;
    }
    priceHistory.stop();
    spreadHistory.stopPersist();
    logger.info("scanner stopped");
  }

  get running(): boolean {
    return this._running;
  }

  get opportunities(): ArbitrageOpportunity[] {
    return this.opportunitiesWithTarget(Infinity);
  }

  /**
   * Return opportunities annotated with spread history stats.
   * targetedSpreadDecimal: threshold in decimal form (e.g. 0.005 = 0.5%).
   * spreadTimesHit = count of 1-second samples where spreadPct ≤ threshold.
   */
  opportunitiesWithTarget(targetedSpreadDecimal: number): ArbitrageOpportunity[] {
    return this._opportunities.map((opp) => {
      const key = spreadHistory.makeKey(opp.symbol, opp.longExchange, opp.shortExchange);
      const stats = spreadHistory.getStats(key);
      const timesHit = isFinite(targetedSpreadDecimal)
        ? spreadHistory.getTimesBelow(key, targetedSpreadDecimal)
        : stats.sampleCount;
      return {
        ...opp,
        spreadSampleCount: stats.sampleCount,
        lowestSpreadPct: stats.lowestSpreadPct,
        spreadTimesHit: timesHit,
      };
    });
  }

  get lastUpdatedAt(): number | null {
    return this._lastUpdatedAt;
  }

  getPriceHistory(): Record<string, import("./price-history").PriceSample[]> {
    return priceHistory.getAll();
  }

  getPriceMovements(): Record<string, Record<string, number | null>> {
    return priceHistory.getMovements();
  }

  getExchangeStatuses(): ExchangeStatusInfo[] {
    const now = Date.now();
    const STALE_MS = 120_000;

    const makeStatus = (exchange: Exchange): ExchangeStatusInfo => {
      const ticks = this.feedState.get(exchange)!;
      const lastDataAt = this.exchangeLastDataAt.get(exchange) ?? null;
      const online = lastDataAt != null && now - lastDataAt < STALE_MS;
      return {
        exchange,
        status: online ? "online" : lastDataAt != null ? "degraded" : "offline",
        lastDataAt,
        errorMessage: null,
        instrumentCount: ticks.size,
      };
    };

    return [
      makeStatus("pi42"),
      makeStatus("aster"),
      makeStatus("delta"),
      makeStatus("coinswitch"),
    ];
  }

  getMarkets(): {
    pi42: FeedTick[];
    aster: FeedTick[];
    delta: FeedTick[];
    coinswitch: FeedTick[];
  } {
    return {
      pi42: Array.from(this.feedState.get("pi42")!.values()),
      aster: Array.from(this.feedState.get("aster")!.values()),
      delta: Array.from(this.feedState.get("delta")!.values()),
      coinswitch: Array.from(this.feedState.get("coinswitch")!.values()),
    };
  }

  private onTick(tick: FeedTick) {
    const exchangeMap = this.feedState.get(tick.exchange);
    if (!exchangeMap) return;

    exchangeMap.set(tick.symbol, tick);
    this.exchangeLastDataAt.set(tick.exchange, Date.now());

    // Debounce: rebuild at most once per 50ms regardless of tick frequency.
    // Prevents O(n²) work running hundreds of times per second on WS bursts.
    if (this.rebuildTimer === null) {
      this.rebuildTimer = setTimeout(() => {
        this.rebuildTimer = null;
        const leverageMaps: ReadonlyMap<Exchange, ReadonlyMap<string, number>> = new Map([
          ["pi42",       this.pi42.getLeverageMap()],
          ["aster",      this.aster.getLeverageMap()],
          ["delta",      this.delta.getLeverageMap()],
          ["coinswitch", this.coinswitch.getLeverageMap()],
        ]);
        this._opportunities = buildOpportunities(this.feedState, undefined, leverageMaps);
        this._lastUpdatedAt = Date.now();
      }, 50);
    }
  }
}

export const scanner = new Scanner();
