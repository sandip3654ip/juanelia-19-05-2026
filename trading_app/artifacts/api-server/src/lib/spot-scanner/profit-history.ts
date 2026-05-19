/**
 * Rolling 5-hour NET PROFIT history per spot arbitrage opportunity.
 *
 * Every 1 second the SpotScanner calls snapshot() with the current opportunity
 * list and we append each opp's `netProfitPct` to a per-key ring buffer.
 *
 * Key format: `${symbol}|${buyExchange}|${sellExchange}` — uniquely identifies
 * a directional opportunity (BTC bought on binance, sold on bybit, etc.).
 *
 * Retention: 5h × 3600 samples/h = 18000 samples per key.
 *
 * Persistence:
 *  - loadFromDisk() on start — survives server restarts.
 *  - saveToDisk()   every PERSIST_INTERVAL_MS (60s).
 *  - clearAll()     wipes memory + disk file (called by reset endpoint).
 */

import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.js";
import type { SpotOpportunity } from "./types.js";

export interface ProfitSample {
  ts:            number;
  netProfitPct:  number;
  priceDiffPct:  number;
}

const MAX_SAMPLES          = 9_000;   // 5h × 1 sample / 2s = 9000 max
const MAX_AGE_MS           = 5 * 3_600_000;
const SNAPSHOT_INTERVAL_MS = 2_000;   // 2s — halves array-shift CPU vs 1s
const PERSIST_INTERVAL_MS  = 60_000;
const PRUNE_INTERVAL_MS    = 60_000;

const DATA_DIR  = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "spot-profit-history.json");

export function makeProfitKey(symbol: string, buyExchange: string, sellExchange: string): string {
  return `${symbol}|${buyExchange}|${sellExchange}`;
}

class SpotProfitHistoryStore {
  private store: Map<string, ProfitSample[]> = new Map();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer:    ReturnType<typeof setInterval> | null = null;
  private persistTimer:  ReturnType<typeof setInterval> | null = null;
  private _version = 0;

  /** Increments each time a snapshot is taken — used by callers to detect stale caches. */
  getVersion(): number { return this._version; }

  // ── Disk persistence ────────────────────────────────────────────────────────

  loadFromDisk(): void {
    try {
      const raw    = readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw) as Record<string, ProfitSample[]>;
      const cutoff = Date.now() - MAX_AGE_MS;
      let keys = 0, samples = 0;
      for (const [key, buf] of Object.entries(parsed)) {
        if (!Array.isArray(buf) || buf.length === 0) continue;
        const fresh = buf.filter((s) => s.ts > cutoff);
        if (fresh.length === 0) continue;
        this.store.set(key, fresh);
        keys++;
        samples += fresh.length;
      }
      logger.info({ keys, samples }, "spot profit history loaded from disk");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn({ err: (err as Error).message }, "spot profit history load failed — starting fresh");
      }
    }
  }

  saveToDisk(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    const obj: Record<string, ProfitSample[]> = {};
    for (const [k, v] of this.store) obj[k] = v;
    writeFile(DATA_FILE, JSON.stringify(obj), "utf8").catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, "spot profit history save failed");
    });
  }

  /** Wipe all in-memory data and delete the disk file. */
  clearAll(): void {
    this.store.clear();
    try { unlinkSync(DATA_FILE); } catch { /* ok if missing */ }
    logger.info("spot profit history cleared");
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(getOpportunities: () => readonly SpotOpportunity[]): void {
    this.loadFromDisk();
    this.snapshotTimer = setInterval(
      () => this.snapshot(getOpportunities()),
      SNAPSHOT_INTERVAL_MS,
    );
    this.pruneTimer    = setInterval(() => this.prune(),       PRUNE_INTERVAL_MS);
    this.persistTimer  = setInterval(() => this.saveToDisk(),  PERSIST_INTERVAL_MS);
  }

  stop(): void {
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }
    if (this.pruneTimer)    { clearInterval(this.pruneTimer);    this.pruneTimer    = null; }
    if (this.persistTimer)  { clearInterval(this.persistTimer);  this.persistTimer  = null; }
    this.saveToDisk();
  }

  snapshot(opps: readonly SpotOpportunity[]): void {
    this._version++;
    const now = Date.now();
    for (const opp of opps) {
      const netPct  = opp.netProfitPct;
      const diffPct = opp.priceDiffPct;
      if (netPct == null || !Number.isFinite(netPct)) continue;
      if (diffPct == null || !Number.isFinite(diffPct)) continue;
      const key = makeProfitKey(opp.symbol, opp.buyExchange, opp.sellExchange);
      let buf = this.store.get(key);
      if (!buf) { buf = []; this.store.set(key, buf); }
      // Trim from front before push to avoid O(n) shift after buffer is full
      if (buf.length >= MAX_SAMPLES) buf.shift();
      buf.push({ ts: now, netProfitPct: netPct, priceDiffPct: diffPct });
    }
  }

  private prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    let droppedSamples = 0;
    let droppedKeys    = 0;
    for (const [key, buf] of this.store) {
      let firstFresh = 0;
      while (firstFresh < buf.length && buf[firstFresh].ts <= cutoff) firstFresh++;
      if (firstFresh === 0) continue;
      droppedSamples += firstFresh;
      if (firstFresh >= buf.length) {
        this.store.delete(key);
        droppedKeys++;
      } else {
        buf.splice(0, firstFresh);
      }
    }
    if (droppedSamples > 0) {
      logger.info(
        { droppedSamples, droppedKeys, liveKeys: this.store.size },
        "spot profit history: pruned stale samples",
      );
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getAll(): Record<string, ProfitSample[]> {
    return Object.fromEntries(this.store);
  }

  get(key: string): ProfitSample[] | undefined {
    return this.store.get(key);
  }

  getTimesAbove(key: string, thresholdPct: number, windowMs = 4 * 3_600_000): number {
    const buf = this.store.get(key);
    if (!buf || buf.length === 0) return 0;
    const cutoff = Date.now() - windowMs;
    let count = 0;
    for (const s of buf) {
      if (s.ts >= cutoff && s.netProfitPct >= thresholdPct) count++;
    }
    return count;
  }

  getHighest(key: string, windowMs = 4 * 3_600_000): number | null {
    const buf = this.store.get(key);
    if (!buf || buf.length === 0) return null;
    const cutoff = Date.now() - windowMs;
    let highest = -Infinity;
    let found   = false;
    for (const s of buf) {
      if (s.ts >= cutoff) {
        found = true;
        if (s.netProfitPct > highest) highest = s.netProfitPct;
      }
    }
    return found ? highest : null;
  }

  getLowest(key: string, windowMs = 4 * 3_600_000): number | null {
    const buf = this.store.get(key);
    if (!buf || buf.length === 0) return null;
    const cutoff = Date.now() - windowMs;
    let lowest = Infinity;
    let found  = false;
    for (const s of buf) {
      if (s.ts >= cutoff) {
        found = true;
        if (s.netProfitPct < lowest) lowest = s.netProfitPct;
      }
    }
    return found ? lowest : null;
  }

  get keyCount(): number {
    return this.store.size;
  }

  /**
   * Compute alternating crossover intervals per key.
   * Each interval is either "pos" (net >= 0) or "neg" (net < 0).
   * peakPct = max net for pos intervals, min net (most negative) for neg intervals.
   * count = number of positive intervals only (backward-compat).
   * Returns last `maxEvents` interleaved pos+neg events, newest-first.
   */
  getCrossoversAll(threshold = 0, maxEvents = 20): Record<string, { count: number; events: CrossoverEvent[] }> {
    const result: Record<string, { count: number; events: CrossoverEvent[] }> = {};
    for (const [key, buf] of this.store) {
      if (!buf || buf.length === 0) continue;

      const allEvents: CrossoverEvent[] = [];
      let curDir: "pos" | "neg" | null = null;
      let runStart = 0, runPeak = 0, runPeakSpread = 0, runLastTs = 0;

      const push = (dir: "pos" | "neg") => {
        allEvents.push({
          ts: runStart, direction: dir,
          peakPct: runPeak, peakSpreadPct: runPeakSpread,
          durationMs: runLastTs - runStart,
        });
      };

      for (const s of buf) {
        const dir: "pos" | "neg" = s.netProfitPct >= 0 ? "pos" : "neg";
        if (dir !== curDir) {
          if (curDir !== null) push(curDir);
          curDir        = dir;
          runStart      = s.ts;
          runPeak       = s.netProfitPct;
          runPeakSpread = s.priceDiffPct ?? 0;
          runLastTs     = s.ts;
        } else {
          if (dir === "pos" ? s.netProfitPct > runPeak : s.netProfitPct < runPeak) runPeak = s.netProfitPct;
          const sp = s.priceDiffPct ?? 0;
          if (dir === "pos" ? sp > runPeakSpread : sp < runPeakSpread) runPeakSpread = sp;
          runLastTs = s.ts;
        }
      }
      if (curDir !== null) push(curDir);

      const posCount = allEvents.filter((e) => e.direction === "pos" && e.peakPct > threshold).length;
      if (posCount === 0) continue;

      result[key] = {
        count:  posCount,
        events: allEvents.slice(-maxEvents).reverse(),   // newest-first
      };
    }
    return result;
  }
}

export interface CrossoverEvent {
  ts:            number;
  direction:     "pos" | "neg";
  peakPct:       number;        // max net for pos; min net (negative value) for neg
  peakSpreadPct: number;
  durationMs:    number;
}

export const spotProfitHistory = new SpotProfitHistoryStore();
