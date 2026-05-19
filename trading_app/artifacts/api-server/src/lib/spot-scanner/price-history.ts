/**
 * Rolling 73-hour SPOT price history — row-per-snapshot format.
 *
 * Every 30 seconds, a single snapshot captures ALL exchanges' ask prices
 * for ALL symbols in one atomic row:
 *   { ts, data: { binance: {BTC: ask, …}, bybit: {…}, kucoin: {…}, bitget: {…} } }
 *
 * Benefits vs the old two-file design:
 *   • Single file — one write per persist interval
 *   • Naturally load-balanced — all exchanges captured at the same time
 *   • No separate representative vs per-exchange split needed
 *   • Easy replay of any time window by slicing rows
 *
 * Capacity: 73h × 120 rows/h = 8 760 rows max
 * Persistence: disk write every 15s and on stop(); load on startup.
 */

import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.js";

export interface SpotPriceSample {
  ts: number;    // Unix epoch ms
  price: number; // ask price in USDT
}

export interface SpotQuote {
  bid: number;
  ask: number;
  receivedAt: number;
}

/** One row = one 30-second snapshot across all exchanges */
interface SnapshotRow {
  ts: number;
  /** exchange → symbol → ask price */
  data: Record<string, Record<string, number>>;
  /** exchange → symbol → bid price (added later — optional for backward compat) */
  bids?: Record<string, Record<string, number>>;
}

/** Max rows: 73h × 120 snapshots/h (one every 30s) */
const MAX_ROWS            = 3_000;
const MAX_AGE_MS          = 25 * 3_600_000; // 25 hours
const PERSIST_INTERVAL_MS = 15_000;         // save to disk every 15s — smaller crash gap
const SNAPSHOT_INTERVAL_MS = 30_000;        // 30 seconds per snapshot

/** Priority order for picking a representative ask price per symbol */
const EXCHANGE_PRIORITY = ["binance", "kucoin", "bybit", "bitget"] as const;
type Exchange = (typeof EXCHANGE_PRIORITY)[number];

const DATA_DIR  = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "spot-price-history.json");

/** Cached results — invalidated on every snapshot() call */
interface ResultCache {
  movements?:       Record<string, Record<string, number | null>>;
  exMovements?:     Record<string, Record<string, Record<string, number | null>>>;
  sparklines?:      Record<string, Record<string, SpotPriceSample[]>>;
  miniSparklines?:  Record<string, Record<string, SpotPriceSample[]>>;
  bidSparklines?:   Record<string, Record<string, SpotPriceSample[]>>;
  bidMiniSparklines?: Record<string, Record<string, SpotPriceSample[]>>;
}

/**
 * Evenly downsample an array to at most `maxPoints` elements.
 * Always preserves the last element so the chart is up-to-date.
 */
function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const result: T[] = [];
  const step = (arr.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints - 1; i++) {
    result.push(arr[Math.round(i * step)]);
  }
  result.push(arr[arr.length - 1]); // always include latest
  return result;
}

class SpotPriceHistoryStore {
  private rows: SnapshotRow[] = [];
  private persistTimer:  ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  /** Cache invalidated on each snapshot to avoid re-computing on every HTTP request */
  private cache: ResultCache = {};

  // ── Disk persistence ────────────────────────────────────────────────────────

  loadFromDisk(): void {
    try {
      const raw    = readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw) as SnapshotRow[];
      if (!Array.isArray(parsed)) return;
      const cutoff = Date.now() - MAX_AGE_MS;
      this.rows = parsed.filter((r) => r.ts > cutoff).slice(-MAX_ROWS);
      logger.info({ rows: this.rows.length }, "spot price history loaded from disk");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn(
          { err: (err as Error).message },
          "spot price history load failed — starting fresh",
        );
      }
    }
  }

  saveToDisk(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify(this.rows);
    writeFile(DATA_FILE, payload, "utf8").catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, "spot price history save failed");
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(
    getQuoteMaps: () => Map<string, Map<string, SpotQuote>>,
    onSnapshot?: () => void,
  ): void {
    this.loadFromDisk();
    // First snapshot after 3s — adapters seed within 1-2s, so data is available.
    // Also fills the gap between last disk save and now as a flat LOCF line.
    setTimeout(() => {
      this.snapshot(getQuoteMaps());
      this.saveToDisk();
      if (onSnapshot) setImmediate(onSnapshot);
    }, 3_000);
    this.snapshotTimer = setInterval(() => {
      this.snapshot(getQuoteMaps());
      if (onSnapshot) setImmediate(onSnapshot);
    }, SNAPSHOT_INTERVAL_MS);
    this.persistTimer  = setInterval(() => this.saveToDisk(), PERSIST_INTERVAL_MS);
  }

  stop(): void {
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }
    if (this.persistTimer)  { clearInterval(this.persistTimer);  this.persistTimer  = null; }
    this.saveToDisk();
  }

  /** Wipe all in-memory rows and delete the disk file. */
  clearAll(): void {
    this.rows = [];
    this.cache = {};
    try { unlinkSync(DATA_FILE); } catch { /* ok if missing */ }
    logger.info("spot price history cleared");
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────────

  /**
   * Capture ONE row: for every exchange, record each symbol's ask price.
   * All exchanges are sampled at the same timestamp for natural load-balancing.
   */
  snapshot(exchangeQuotes: Map<string, Map<string, SpotQuote>>): void {
    const now = Date.now();
    const row: SnapshotRow = { ts: now, data: {}, bids: {} };
    let total = 0;

    for (const ex of EXCHANGE_PRIORITY) {
      const quotes = exchangeQuotes.get(ex);
      if (!quotes) continue;
      const exAsk: Record<string, number> = {};
      const exBid: Record<string, number> = {};
      for (const [sym, q] of quotes) {
        if (q.ask > 0 && Number.isFinite(q.ask)) { exAsk[sym] = q.ask; total++; }
        if (q.bid > 0 && Number.isFinite(q.bid))  { exBid[sym] = q.bid; }
      }
      if (Object.keys(exAsk).length > 0) row.data[ex] = exAsk;
      if (Object.keys(exBid).length > 0) row.bids![ex] = exBid;
    }

    this.rows.push(row);

    // Prune by age then by count cap
    const cutoff = now - MAX_AGE_MS;
    let firstFresh = 0;
    while (firstFresh < this.rows.length && this.rows[firstFresh].ts <= cutoff) firstFresh++;
    if (firstFresh > 0) this.rows.splice(0, firstFresh);
    if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);

    // Invalidate all cached results — they will be recomputed lazily on next request
    this.cache = {};

    logger.debug({ rowCount: this.rows.length, symbolEntries: total }, "spot price history snapshot");
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /** Build a representative {ts, price} series for one symbol from rows. */
  private buildRepresentativeSeries(symbol: string, rows = this.rows): SpotPriceSample[] {
    const result: SpotPriceSample[] = [];
    for (const row of rows) {
      let price: number | null = null;
      for (const ex of EXCHANGE_PRIORITY) {
        const p = row.data[ex]?.[symbol];
        if (p != null && p > 0) { price = p; break; }
      }
      if (price != null) result.push({ ts: row.ts, price });
    }
    return result;
  }

  /** Collect all symbols seen across rows. */
  private allSymbols(rows = this.rows): Set<string> {
    const syms = new Set<string>();
    for (const row of rows) {
      for (const exData of Object.values(row.data)) {
        for (const sym of Object.keys(exData)) syms.add(sym);
      }
    }
    return syms;
  }

  // ── Public accessors ─────────────────────────────────────────────────────────

  get(symbol: string): SpotPriceSample[] {
    return this.buildRepresentativeSeries(symbol);
  }

  getAll(): Record<string, SpotPriceSample[]> {
    const result: Record<string, SpotPriceSample[]> = {};
    for (const sym of this.allSymbols()) {
      result[sym] = this.buildRepresentativeSeries(sym);
    }
    return result;
  }

  /**
   * Pre-compute % price movement over each window for every symbol.
   * Returns { symbol → { "4H": pct | null, "8H": pct | null, … } }
   */
  getMovements(
    windowsMs: number[] = [4, 8, 12, 24, 48, 72].map((h) => h * 3_600_000),
  ): Record<string, Record<string, number | null>> {
    if (this.cache.movements) return this.cache.movements;
    const result: Record<string, Record<string, number | null>> = {};
    for (const sym of this.allSymbols()) {
      const series = this.buildRepresentativeSeries(sym);
      if (series.length < 2) continue;
      const latest = series[series.length - 1];
      const entry: Record<string, number | null> = {};
      for (const ms of windowsMs) {
        const cutoff = latest.ts - ms;
        // Binary search: find rightmost index where ts <= cutoff
        let lo = 0, hi = series.length - 2, idx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (series[mid].ts <= cutoff) { idx = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        const old = idx >= 0 ? series[idx] : null;
        /* Reject reference point if it is more than 1.5 hours before the cutoff.
           A larger gap means the data comes from a disconnected period (server restart gap)
           and the computed % would be misleading — show null instead. */
        const validOld = old !== null && (cutoff - old.ts) <= 5_400_000 ? old : null;
        entry[`${ms / 3_600_000}H`] =
          validOld != null ? ((latest.price - validOld.price) / validOld.price) * 100 : null;
      }
      result[sym] = entry;
    }
    this.cache.movements = result;
    return result;
  }

  /**
   * Per-exchange price movements over standard windows.
   * Shape: { binance: { BTC: { "4H": pct, … } }, bybit: { … }, … }
   */
  getExchangeMovements(
    windowsMs: number[] = [4, 8, 12, 24, 48, 72].map((h) => h * 3_600_000),
  ): Record<string, Record<string, Record<string, number | null>>> {
    if (this.cache.exMovements) return this.cache.exMovements;
    // Build per-exchange per-symbol series from rows in one pass
    const exSymSeries: Record<string, Record<string, SpotPriceSample[]>> = {};
    for (const row of this.rows) {
      for (const [ex, exData] of Object.entries(row.data)) {
        if (!exSymSeries[ex]) exSymSeries[ex] = {};
        for (const [sym, ask] of Object.entries(exData)) {
          if (!exSymSeries[ex][sym]) exSymSeries[ex][sym] = [];
          exSymSeries[ex][sym].push({ ts: row.ts, price: ask });
        }
      }
    }

    const result: Record<string, Record<string, Record<string, number | null>>> = {};
    for (const [ex, symMap] of Object.entries(exSymSeries)) {
      for (const [sym, series] of Object.entries(symMap)) {
        if (series.length < 2) continue;
        const latest = series[series.length - 1];
        const entry: Record<string, number | null> = {};
        for (const ms of windowsMs) {
          const cutoff = latest.ts - ms;
          // Binary search: find rightmost index where ts <= cutoff
          let lo = 0, hi = series.length - 2, idx = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (series[mid].ts <= cutoff) { idx = mid; lo = mid + 1; }
            else hi = mid - 1;
          }
          const old = idx >= 0 ? series[idx] : null;
          /* Same gap-rejection rule as getMovements() */
          const validOld = old !== null && (cutoff - old.ts) <= 5_400_000 ? old : null;
          entry[`${ms / 3_600_000}H`] =
            validOld != null ? ((latest.price - validOld.price) / validOld.price) * 100 : null;
        }
        if (!result[ex]) result[ex] = {};
        result[ex][sym] = entry;
      }
    }
    this.cache.exMovements = result;
    return result;
  }

  /**
   * Return per-exchange per-symbol sparklines derived from rows (full resolution),
   * with forward-fill (LOCF) so every series is gap-free across the full history.
   *
   * For any snapshot row where an exchange has no fresh data for a symbol, the last
   * known ask price is carried forward — turning exchange-offline gaps or server-restart
   * gaps into flat lines rather than visual breaks in the chart.
   *
   * Shape: { binance: { BTC: [{ts, price},...] }, bybit: {…}, … }
   * `limit` caps the number of rows used (newest N rows).
   */
  getExchangeSparklines(limit = 3000): Record<string, Record<string, SpotPriceSample[]>> {
    if (this.cache.sparklines) return this.cache.sparklines;
    const rows = limit >= this.rows.length ? this.rows : this.rows.slice(-limit);
    const result: Record<string, Record<string, SpotPriceSample[]>> = {};

    // Last known ask price per exchange per symbol — used to forward-fill gaps
    const lastKnown: Record<string, Record<string, number>> = {};
    // Track previous row timestamp to detect and fill time gaps (e.g. server restart)
    let prevTs: number | null = null;

    for (const row of rows) {
      // ── Time-gap fill ────────────────────────────────────────────────────────
      // If consecutive rows have a gap > 2×SNAPSHOT_INTERVAL_MS (i.e. the server
      // was down), emit synthetic LOCF rows at 30s intervals to bridge the gap.
      // This turns a visual hole in the chart into a flat carry-forward line.
      if (prevTs !== null && row.ts - prevTs > SNAPSHOT_INTERVAL_MS * 2) {
        let fillTs = prevTs + SNAPSHOT_INTERVAL_MS;
        while (fillTs < row.ts) {
          for (const [ex, symMap] of Object.entries(lastKnown)) {
            if (!result[ex]) result[ex] = {};
            for (const [sym, price] of Object.entries(symMap)) {
              if (!result[ex][sym]) result[ex][sym] = [];
              result[ex][sym].push({ ts: fillTs, price });
            }
          }
          fillTs += SNAPSHOT_INTERVAL_MS;
        }
      }
      prevTs = row.ts;

      // Step 1: refresh lastKnown with fresh data from this snapshot row
      for (const [ex, exData] of Object.entries(row.data)) {
        if (!lastKnown[ex]) lastKnown[ex] = {};
        for (const [sym, ask] of Object.entries(exData)) {
          lastKnown[ex][sym] = ask;
        }
      }

      // Step 2: emit a point for every exchange+symbol we have ever seen,
      // using the fresh ask if available, otherwise the carried-forward price.
      for (const [ex, symMap] of Object.entries(lastKnown)) {
        if (!result[ex]) result[ex] = {};
        for (const [sym, price] of Object.entries(symMap)) {
          if (!result[ex][sym]) result[ex][sym] = [];
          result[ex][sym].push({ ts: row.ts, price });
        }
      }
    }

    this.cache.sparklines = result;
    return result;
  }

  /**
   * Downsampled sparklines for mini charts in cards — full history but capped to
   * `maxPoints` evenly-spaced samples per series. Much smaller payload (~60×) than
   * the full sparklines, fast to transfer and parse.
   */
  getExchangeMiniSparklines(maxPoints = 60): Record<string, Record<string, SpotPriceSample[]>> {
    if (this.cache.miniSparklines) return this.cache.miniSparklines;
    const full = this.getExchangeSparklines();
    const result: Record<string, Record<string, SpotPriceSample[]>> = {};
    for (const [ex, symMap] of Object.entries(full)) {
      for (const [sym, samples] of Object.entries(symMap)) {
        if (!result[ex]) result[ex] = {};
        result[ex][sym] = downsample(samples, maxPoints);
      }
    }
    this.cache.miniSparklines = result;
    return result;
  }

  /**
   * Per-exchange **bid**-price sparklines (full resolution, LOCF gap-fill).
   * Mirrors getExchangeSparklines() but reads from the `bids` field of each row.
   * Old rows that pre-date the bids field are skipped gracefully.
   */
  getExchangeBidSparklines(limit = 3000): Record<string, Record<string, SpotPriceSample[]>> {
    if (this.cache.bidSparklines) return this.cache.bidSparklines;
    const rows = limit >= this.rows.length ? this.rows : this.rows.slice(-limit);
    const result: Record<string, Record<string, SpotPriceSample[]>> = {};

    const lastKnown: Record<string, Record<string, number>> = {};
    let prevTs: number | null = null;

    for (const row of rows) {
      // For rows that pre-date bid tracking, fall back to ask prices as proxy.
      // Bid ≈ ask for sparkline continuity purposes (spread <0.1%).
      const bidData = row.bids ?? row.data;
      if (!bidData || Object.keys(bidData).length === 0) continue;

      if (prevTs !== null && row.ts - prevTs > SNAPSHOT_INTERVAL_MS * 2) {
        let fillTs = prevTs + SNAPSHOT_INTERVAL_MS;
        while (fillTs < row.ts) {
          for (const [ex, symMap] of Object.entries(lastKnown)) {
            if (!result[ex]) result[ex] = {};
            for (const [sym, price] of Object.entries(symMap)) {
              if (!result[ex][sym]) result[ex][sym] = [];
              result[ex][sym].push({ ts: fillTs, price });
            }
          }
          fillTs += SNAPSHOT_INTERVAL_MS;
        }
      }
      prevTs = row.ts;

      for (const [ex, exData] of Object.entries(bidData)) {
        if (!lastKnown[ex]) lastKnown[ex] = {};
        for (const [sym, bid] of Object.entries(exData)) {
          lastKnown[ex][sym] = bid;
        }
      }

      for (const [ex, symMap] of Object.entries(lastKnown)) {
        if (!result[ex]) result[ex] = {};
        for (const [sym, price] of Object.entries(symMap)) {
          if (!result[ex][sym]) result[ex][sym] = [];
          result[ex][sym].push({ ts: row.ts, price });
        }
      }
    }

    this.cache.bidSparklines = result;
    return result;
  }

  /** Downsampled bid sparklines for mini cards. */
  getExchangeBidMiniSparklines(maxPoints = 60): Record<string, Record<string, SpotPriceSample[]>> {
    if (this.cache.bidMiniSparklines) return this.cache.bidMiniSparklines;
    const full = this.getExchangeBidSparklines();
    const result: Record<string, Record<string, SpotPriceSample[]>> = {};
    for (const [ex, symMap] of Object.entries(full)) {
      for (const [sym, samples] of Object.entries(symMap)) {
        if (!result[ex]) result[ex] = {};
        result[ex][sym] = downsample(samples, maxPoints);
      }
    }
    this.cache.bidMiniSparklines = result;
    return result;
  }

  /**
   * Build downsampled ask-price mini sparklines for ONLY the specified symbol set.
   * Much faster than getExchangeMiniSparklines() when the active set is small
   * (e.g. 100–200 symbols) vs the total universe (2 000+ across all exchanges).
   * Complexity: O(rows × |symbols|) instead of O(rows × all_symbols).
   * Does NOT use or update the shared cache — callers manage their own cache.
   */
  buildMiniSparklinesForSymbols(
    symbols: Set<string>,
    maxPoints = 60,
  ): Record<string, Record<string, SpotPriceSample[]>> {
    const result: Record<string, Record<string, SpotPriceSample[]>> = {};
    const lastKnown: Record<string, Record<string, number>> = {};
    let prevTs: number | null = null;

    for (const row of this.rows) {
      // Gap-fill: emit LOCF points to bridge server-restart holes
      if (prevTs !== null && row.ts - prevTs > SNAPSHOT_INTERVAL_MS * 2) {
        let fillTs = prevTs + SNAPSHOT_INTERVAL_MS;
        while (fillTs < row.ts) {
          for (const [ex, symMap] of Object.entries(lastKnown)) {
            if (!result[ex]) result[ex] = {};
            for (const [sym, price] of Object.entries(symMap)) {
              if (!result[ex][sym]) result[ex][sym] = [];
              result[ex][sym].push({ ts: fillTs, price });
            }
          }
          fillTs += SNAPSHOT_INTERVAL_MS;
        }
      }
      prevTs = row.ts;

      // Update lastKnown — only for symbols in the active set
      for (const [ex, exData] of Object.entries(row.data)) {
        if (!lastKnown[ex]) lastKnown[ex] = {};
        for (const [sym, price] of Object.entries(exData)) {
          if (!symbols.has(sym)) continue;
          lastKnown[ex][sym] = price;
        }
      }

      // Emit LOCF point for every tracked symbol
      for (const [ex, symMap] of Object.entries(lastKnown)) {
        if (!result[ex]) result[ex] = {};
        for (const [sym, price] of Object.entries(symMap)) {
          if (!result[ex][sym]) result[ex][sym] = [];
          result[ex][sym].push({ ts: row.ts, price });
        }
      }
    }

    // Downsample each series to maxPoints
    for (const symMap of Object.values(result)) {
      for (const [sym, samples] of Object.entries(symMap)) {
        symMap[sym] = downsample(samples, maxPoints);
      }
    }
    return result;
  }

  /**
   * Same as buildMiniSparklinesForSymbols() but uses bid prices.
   * Falls back to ask for rows that pre-date bid tracking.
   */
  buildBidMiniSparklinesForSymbols(
    symbols: Set<string>,
    maxPoints = 60,
  ): Record<string, Record<string, SpotPriceSample[]>> {
    const result: Record<string, Record<string, SpotPriceSample[]>> = {};
    const lastKnown: Record<string, Record<string, number>> = {};
    let prevTs: number | null = null;

    for (const row of this.rows) {
      const bidData = row.bids ?? row.data;
      if (!bidData || Object.keys(bidData).length === 0) continue;

      if (prevTs !== null && row.ts - prevTs > SNAPSHOT_INTERVAL_MS * 2) {
        let fillTs = prevTs + SNAPSHOT_INTERVAL_MS;
        while (fillTs < row.ts) {
          for (const [ex, symMap] of Object.entries(lastKnown)) {
            if (!result[ex]) result[ex] = {};
            for (const [sym, price] of Object.entries(symMap)) {
              if (!result[ex][sym]) result[ex][sym] = [];
              result[ex][sym].push({ ts: fillTs, price });
            }
          }
          fillTs += SNAPSHOT_INTERVAL_MS;
        }
      }
      prevTs = row.ts;

      for (const [ex, exData] of Object.entries(bidData)) {
        if (!lastKnown[ex]) lastKnown[ex] = {};
        for (const [sym, price] of Object.entries(exData)) {
          if (!symbols.has(sym)) continue;
          lastKnown[ex][sym] = price;
        }
      }

      for (const [ex, symMap] of Object.entries(lastKnown)) {
        if (!result[ex]) result[ex] = {};
        for (const [sym, price] of Object.entries(symMap)) {
          if (!result[ex][sym]) result[ex][sym] = [];
          result[ex][sym].push({ ts: row.ts, price });
        }
      }
    }

    for (const symMap of Object.values(result)) {
      for (const [sym, samples] of Object.entries(symMap)) {
        symMap[sym] = downsample(samples, maxPoints);
      }
    }
    return result;
  }

  /**
   * Fast ask-price sparklines for ONE symbol only.
   * O(rows × 4 exchanges) vs O(rows × 2000+ symbols) for getExchangeSparklines().
   * Use for chart modal requests where only one symbol is needed at a time.
   */
  getAskSparklineForSymbol(symbol: string): Record<string, SpotPriceSample[]> {
    const result: Record<string, SpotPriceSample[]> = {};
    const lastKnown: Record<string, number> = {};
    let prevTs: number | null = null;

    for (const row of this.rows) {
      if (prevTs !== null && row.ts - prevTs > SNAPSHOT_INTERVAL_MS * 2) {
        let fillTs = prevTs + SNAPSHOT_INTERVAL_MS;
        while (fillTs < row.ts) {
          for (const [ex, price] of Object.entries(lastKnown)) {
            if (!result[ex]) result[ex] = [];
            result[ex].push({ ts: fillTs, price });
          }
          fillTs += SNAPSHOT_INTERVAL_MS;
        }
      }
      prevTs = row.ts;

      for (const ex of EXCHANGE_PRIORITY) {
        const price = (row.data[ex] as Record<string, number> | undefined)?.[symbol];
        if (price != null && price > 0) lastKnown[ex] = price;
      }
      for (const [ex, price] of Object.entries(lastKnown)) {
        if (!result[ex]) result[ex] = [];
        result[ex].push({ ts: row.ts, price });
      }
    }
    return result;
  }

  /**
   * Fast bid-price sparklines for ONE symbol only.
   * Mirrors getAskSparklineForSymbol() but reads from the `bids` field.
   */
  getBidSparklineForSymbol(symbol: string): Record<string, SpotPriceSample[]> {
    const result: Record<string, SpotPriceSample[]> = {};
    const lastKnown: Record<string, number> = {};
    let prevTs: number | null = null;

    for (const row of this.rows) {
      const bidData = row.bids ?? row.data;
      if (!bidData || Object.keys(bidData).length === 0) continue;

      if (prevTs !== null && row.ts - prevTs > SNAPSHOT_INTERVAL_MS * 2) {
        let fillTs = prevTs + SNAPSHOT_INTERVAL_MS;
        while (fillTs < row.ts) {
          for (const [ex, price] of Object.entries(lastKnown)) {
            if (!result[ex]) result[ex] = [];
            result[ex].push({ ts: fillTs, price });
          }
          fillTs += SNAPSHOT_INTERVAL_MS;
        }
      }
      prevTs = row.ts;

      for (const ex of EXCHANGE_PRIORITY) {
        const price = (bidData[ex] as Record<string, number> | undefined)?.[symbol];
        if (price != null && price > 0) lastKnown[ex] = price;
      }
      for (const [ex, price] of Object.entries(lastKnown)) {
        if (!result[ex]) result[ex] = [];
        result[ex].push({ ts: row.ts, price });
      }
    }
    return result;
  }

  get symbolCount(): number {
    if (this.rows.length === 0) return 0;
    return this.allSymbols([this.rows[this.rows.length - 1]]).size;
  }

  get rowCount(): number {
    return this.rows.length;
  }
}

export const spotPriceHistory = new SpotPriceHistoryStore();
