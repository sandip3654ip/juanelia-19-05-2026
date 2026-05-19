/**
 * Rolling 4-hour spread history store — with disk persistence.
 *
 * The scanner calls record() every second for every live opportunity.
 * Each entry is keyed by `${symbol}:${longExchange}:${shortExchange}`.
 *
 * Entries older than 4 hours are evicted on each write.
 * getStats() returns the sample count and the lowest spread observed
 * within the rolling window — both values used by the dashboard.
 *
 * Persistence:
 *  - loadFromDisk() on scanner start — survives server restarts.
 *  - saveToDisk()   every PERSIST_INTERVAL_MS (30s).
 *  - clearAll()     wipes memory + disk file (called by reset endpoint).
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";

const FOUR_HOURS_MS       = 4 * 60 * 60 * 1_000;
const PERSIST_INTERVAL_MS = 30_000;

const DATA_DIR  = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "spread-history.json");

interface SpreadBuf {
  ts: number[];
  spread: number[];
}

const store = new Map<string, SpreadBuf>();
let persistTimer: ReturnType<typeof setInterval> | null = null;

// ── Disk persistence ──────────────────────────────────────────────────────────

export function loadFromDisk(): void {
  try {
    const raw    = readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, SpreadBuf>;
    const cutoff = Date.now() - FOUR_HOURS_MS;
    let keys = 0, samples = 0;
    for (const [key, buf] of Object.entries(parsed)) {
      if (!buf.ts || !buf.spread || buf.ts.length === 0) continue;
      let firstFresh = 0;
      while (firstFresh < buf.ts.length && buf.ts[firstFresh] < cutoff) firstFresh++;
      const freshTs     = buf.ts.slice(firstFresh);
      const freshSpread = buf.spread.slice(firstFresh);
      if (freshTs.length === 0) continue;
      store.set(key, { ts: freshTs, spread: freshSpread });
      keys++;
      samples += freshTs.length;
    }
    logger.info({ keys, samples }, "spread history loaded from disk");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err: (err as Error).message }, "spread history load failed — starting fresh");
    }
  }
}

export function saveToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const obj: Record<string, SpreadBuf> = {};
    for (const [k, v] of store) obj[k] = v;
    writeFileSync(DATA_FILE, JSON.stringify(obj), "utf8");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "spread history save failed");
  }
}

export function startPersist(): void {
  if (persistTimer) return;
  persistTimer = setInterval(saveToDisk, PERSIST_INTERVAL_MS);
}

export function stopPersist(): void {
  if (persistTimer) { clearInterval(persistTimer); persistTimer = null; }
  saveToDisk();
}

/** Wipe all in-memory data and delete the disk file. */
export function clearAll(): void {
  store.clear();
  try { unlinkSync(DATA_FILE); } catch { /* ok if missing */ }
  logger.info("spread history cleared");
}

// ── Core operations ───────────────────────────────────────────────────────────

export function makeKey(
  symbol: string,
  longExchange: string,
  shortExchange: string,
): string {
  return `${symbol}:${longExchange}:${shortExchange}`;
}

export function record(key: string, spreadPct: number): void {
  const now = Date.now();
  let buf = store.get(key);
  if (!buf) {
    buf = { ts: [], spread: [] };
    store.set(key, buf);
  }

  buf.ts.push(now);
  buf.spread.push(spreadPct);

  // Evict samples older than 4 hours from the front
  const cutoff = now - FOUR_HOURS_MS;
  let evict = 0;
  while (evict < buf.ts.length && buf.ts[evict] < cutoff) evict++;
  if (evict > 0) {
    buf.ts.splice(0, evict);
    buf.spread.splice(0, evict);
  }
}

export interface SpreadStats {
  sampleCount: number;
  lowestSpreadPct: number;
}

export function getStats(key: string): SpreadStats {
  const buf = store.get(key);
  if (!buf || buf.spread.length === 0) {
    return { sampleCount: 0, lowestSpreadPct: 0 };
  }
  let lowest = Infinity;
  for (const s of buf.spread) {
    if (s < lowest) lowest = s;
  }
  return {
    sampleCount: buf.spread.length,
    lowestSpreadPct: lowest === Infinity ? 0 : lowest,
  };
}

export function getTimesBelow(key: string, thresholdDecimal: number): number {
  const buf = store.get(key);
  if (!buf || buf.spread.length === 0) return 0;
  let count = 0;
  for (const s of buf.spread) {
    if (s <= thresholdDecimal) count++;
  }
  return count;
}

export function pairCount(): number {
  return store.size;
}
