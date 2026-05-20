/**
 * Rolling 73-hour price history store with disk persistence.
 *
 * Every 15 seconds the Scanner calls snapshot(), which:
 *  - Iterates all canonical symbols across all exchanges
 *  - Picks one representative price per symbol (USD-preferred exchange first)
 *  - Appends a { ts, price } sample to a circular buffer capped at 17520 entries
 *
 * Persistence:
 *  - On startup, loadFromDisk() rehydrates the store from the last saved file.
 *  - saveToDisk() is called every PERSIST_INTERVAL_MS (1 min) and on stop().
 *  - This ensures price movement windows (4H/8H/12H/24H/48H/72H) survive server restarts.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger";
import type { FeedTick, Exchange } from "./aggregator";

export interface PriceSample {
  ts: number;    // Unix epoch ms
  price: number; // representative USD price
}

/** Max samples kept per symbol: 73 h × 240 samples/h (15s interval) = 17520 */
const MAX_SAMPLES        = 17_520;
const MAX_AGE_MS         = 73 * 3_600_000;   // 73 hours
const PRUNE_INTERVAL_MS  = 30 * 60_000;      // run pruner every 30 min
const PERSIST_INTERVAL_MS = 60_000;           // save to disk every 1 min

const DATA_DIR  = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "price-history.json");

/**
 * Exchange priority for picking a USD-denominated representative price.
 * Pi42 is INR-denominated so it is last-resort only.
 */
const EXCHANGE_PRIORITY: Exchange[] = ["delta", "aster", "coinswitch", "pi42"];

class PriceHistoryStore {
  private store: Map<string, PriceSample[]> = new Map();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  // ── Disk persistence ──────────────────────────────────────────────────────

  loadFromDisk() {
    try {
      const raw = readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw) as Record<string, PriceSample[]>;
      const now = Date.now();
      const cutoff = now - MAX_AGE_MS;
      let symbols = 0;
      let samples = 0;
      for (const [sym, pts] of Object.entries(parsed)) {
        if (!Array.isArray(pts) || pts.length === 0) continue;
        // Drop samples older than MAX_AGE_MS
        const fresh = pts.filter((p) => p.ts > cutoff);
        if (fresh.length === 0) continue;
        this.store.set(sym, fresh);
        symbols++;
        samples += fresh.length;
      }
      logger.info({ symbols, samples }, "price history loaded from disk");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn({ err: (err as Error).message }, "price history load failed — starting fresh");
      }
      // ENOENT is normal on first startup — no file yet
    }
  }

  saveToDisk() {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const obj = Object.fromEntries(this.store);
      writeFileSync(DATA_FILE, JSON.stringify(obj), "utf8");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "price history save failed");
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  startPruner() {
    this.pruneTimer   = setInterval(() => this.prune(),       PRUNE_INTERVAL_MS);
    this.persistTimer = setInterval(() => this.saveToDisk(),  PERSIST_INTERVAL_MS);
  }

  stop() {
    if (this.pruneTimer)   { clearInterval(this.pruneTimer);   this.pruneTimer   = null; }
    if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null; }
    this.saveToDisk();
  }

  /** Wipe all in-memory data and delete the disk file. */
  clearAll() {
    this.store.clear();
    try { unlinkSync(DATA_FILE); } catch { /* ok if missing */ }
    logger.info("price history cleared");
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  /**
   * Called by the Scanner every 60 seconds.
   * Collects all canonical symbols from feedState and appends one price sample each.
   */
  snapshot(feedState: ReadonlyMap<Exchange, Map<string, FeedTick>>) {
    const now = Date.now();
    let added = 0;

    const allSymbols = new Set<string>();
    for (const ticks of feedState.values()) {
      for (const sym of ticks.keys()) allSymbols.add(sym);
    }

    for (const symbol of allSymbols) {
      let price: number | null = null;
      for (const ex of EXCHANGE_PRIORITY) {
        const tick = feedState.get(ex)?.get(symbol);
        if (!tick) continue;
        price = tick.bestAsk > 0 ? tick.bestAsk : null;
        break;
      }
      if (!price || price <= 0 || !Number.isFinite(price)) continue;

      const buf = this.store.get(symbol) ?? [];
      buf.push({ ts: now, price });

      if (buf.length > MAX_SAMPLES) {
        buf.splice(0, buf.length - MAX_SAMPLES);
      }

      this.store.set(symbol, buf);
      added++;
    }

    logger.debug({ symbols: added }, "price history snapshot");
  }

  // ── Prune ─────────────────────────────────────────────────────────────────

  private prune() {
    const cutoff = Date.now() - MAX_AGE_MS;
    let removed = 0;
    for (const [sym, buf] of this.store) {
      if (buf.length === 0 || buf[buf.length - 1].ts < cutoff) {
        this.store.delete(sym);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info({ removed }, "price history: pruned stale symbols");
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getAll(): Record<string, PriceSample[]> {
    return Object.fromEntries(this.store);
  }

  get(symbol: string): PriceSample[] | undefined {
    return this.store.get(symbol);
  }

  get symbolCount(): number {
    return this.store.size;
  }

  /**
   * Pre-compute 4H/8H/12H/24H/48H/72H % price movements for every symbol.
   * Returns ~50KB instead of raw history, suitable for frequent frontend polling.
   */
  getMovements(): Record<string, Record<string, number | null>> {
    const windows = [
      { label: "4H",  ms:  4 * 3_600_000 },
      { label: "8H",  ms:  8 * 3_600_000 },
      { label: "12H", ms: 12 * 3_600_000 },
      { label: "24H", ms: 24 * 3_600_000 },
      { label: "48H", ms: 48 * 3_600_000 },
      { label: "72H", ms: 72 * 3_600_000 },
    ];

    const out: Record<string, Record<string, number | null>> = {};

    for (const [symbol, buf] of this.store) {
      if (buf.length === 0) continue;
      const latest    = buf[buf.length - 1];
      const latestTs  = latest.ts;
      const entry: Record<string, number | null> = {};

      for (const { label, ms } of windows) {
        const cutoff = latestTs - ms;
        // Binary search: find rightmost index where ts <= cutoff
        let lo = 0, hi = buf.length - 2, idx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (buf[mid].ts <= cutoff) { idx = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        entry[label] = idx >= 0
          ? ((latest.price - buf[idx].price) / buf[idx].price) * 100
          : null;
      }

      out[symbol] = entry;
    }

    return out;
  }
}

export const priceHistory = new PriceHistoryStore();
