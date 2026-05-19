/**
 * Binance Exchange Fee Data
 * ─────────────────────────
 * Fetches the complete public Binance coin/network table and persists it to disk.
 * Refreshes every 4 hours. Loads from disk on startup for zero-latency boot.
 *
 * Saved to:  data/binance-fees.json
 * Endpoint:  https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll
 */

import fs   from "fs";
import path from "path";
import { logger } from "../../logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BinanceNetworkEntry {
  /** Canonical network id as Binance reports it, e.g. "ETH", "BSC", "SOL" */
  network:          string;
  /** Human-readable name, e.g. "Ethereum (ERC20)" */
  networkName:      string;
  /** Withdrawal fee in the coin's own unit */
  withdrawFee:      number;
  /** Minimum withdrawal amount in the coin's own unit */
  minWithdraw:      number;
  /** Maximum withdrawal amount (0 = no limit) */
  maxWithdraw:      number;
  /** Deposit fee — always 0 on Binance */
  depositFee:       number;
  withdrawEnable:   boolean;
  depositEnable:    boolean;
  /** On-chain contract address for this coin on this network (if ERC20-style) */
  contractAddress:  string | null;
  /** Regex that describes a valid address on this network */
  addressRegex:     string;
  /** Whether a memo/tag is required alongside the address */
  requiresMemo:     boolean;
}

/** Per-coin data: network-id → NetworkEntry */
export type BinanceCoinData = Record<string, BinanceNetworkEntry>;

/** Full dataset: coin-symbol → CoinData */
export type BinanceData = Record<string, BinanceCoinData>;

// ── File path ───────────────────────────────────────────────────────────────

const DATA_DIR   = path.join(process.cwd(), "data");
const DATA_FILE  = path.join(DATA_DIR, "binance-fees.json");

const FETCH_URL  = "https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll";
const REFRESH_MS = 60_000; // 1 minute

// ── In-memory cache ─────────────────────────────────────────────────────────

let binanceData: BinanceData = {};
let lastFetchedAt: Date | null = null;

// ── Disk helpers ─────────────────────────────────────────────────────────────

function loadFromDisk(): boolean {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    const raw  = fs.readFileSync(DATA_FILE, "utf8");
    const json = JSON.parse(raw) as { fetchedAt: string; data: BinanceData };
    binanceData    = json.data;
    lastFetchedAt  = new Date(json.fetchedAt);
    logger.info(
      { coins: Object.keys(binanceData).length, file: DATA_FILE },
      "binance fees loaded from disk",
    );
    return true;
  } catch {
    return false;
  }
}

function saveToDisk(data: BinanceData): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ fetchedAt: new Date().toISOString(), data }, null, 2);
    fs.writeFileSync(DATA_FILE, payload, "utf8");
  } catch (err) {
    logger.warn({ err: String(err) }, "failed to save binance fees to disk");
  }
}

// ── Fetch ─────────────────────────────────────────────────────────────────

interface BinanceApiNetworkEntry {
  network:         string;
  name:            string;
  withdrawFee:     string;
  withdrawMin:     string;
  withdrawMax:     string;
  depositFee:      string;
  withdrawEnable:  boolean;
  depositEnable:   boolean;
  contractAddress: string | null;
  addressRegex:    string;
  withdrawIsTag:   boolean;
}

interface BinanceApiResponse {
  data?: Array<{
    coin:        string;
    networkList: BinanceApiNetworkEntry[];
  }>;
}

export async function fetchAndSaveBinance(): Promise<void> {
  try {
    const res = await fetch(FETCH_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as BinanceApiResponse;
    if (!body.data?.length) throw new Error("empty response");

    const newData: BinanceData = {};

    for (const coin of body.data) {
      const symbol = coin.coin.toUpperCase();
      newData[symbol] = {};

      for (const n of coin.networkList) {
        const net = n.network.toUpperCase();
        newData[symbol][net] = {
          network:         net,
          networkName:     n.name,
          withdrawFee:     parseFloat(n.withdrawFee)  || 0,
          minWithdraw:     parseFloat(n.withdrawMin)  || 0,
          maxWithdraw:     parseFloat(n.withdrawMax)  || 0,
          depositFee:      parseFloat(n.depositFee)   || 0,
          withdrawEnable:  n.withdrawEnable,
          depositEnable:   n.depositEnable,
          contractAddress: n.contractAddress ?? null,
          addressRegex:    n.addressRegex    ?? "",
          requiresMemo:    n.withdrawIsTag   ?? false,
        };
      }
    }

    binanceData   = newData;
    lastFetchedAt = new Date();
    saveToDisk(newData);

    logger.info(
      {
        coins:    Object.keys(newData).length,
        networks: Object.values(newData).reduce((s, c) => s + Object.keys(c).length, 0),
      },
      "binance fees fetched and saved",
    );
  } catch (err) {
    logger.warn({ err: String(err) }, "binance fees fetch failed — using cached data");
  }
}

// ── Public accessors ──────────────────────────────────────────────────────────

/** All data for one coin, keyed by Binance network id. Null if coin unknown. */
export function getBinanceCoin(coin: string): BinanceCoinData | null {
  return binanceData[coin.toUpperCase()] ?? null;
}

/** All withdrawal-enabled networks for a coin, sorted cheapest-first. */
export function getBinanceWithdrawNetworks(coin: string): BinanceNetworkEntry[] {
  const c = getBinanceCoin(coin);
  if (!c) return [];
  return Object.values(c)
    .filter(n => n.withdrawEnable)
    .sort((a, b) => a.withdrawFee - b.withdrawFee);
}

/** All deposit-enabled networks for a coin. */
export function getBinanceDepositNetworks(coin: string): BinanceNetworkEntry[] {
  const c = getBinanceCoin(coin);
  if (!c) return [];
  return Object.values(c).filter(n => n.depositEnable);
}

/**
 * Networks that are BOTH withdraw-enabled (for sending out of Binance)
 * AND deposit-enabled (for receiving into Binance), sorted cheapest-first.
 */
export function getBinanceBidirectionalNetworks(coin: string): BinanceNetworkEntry[] {
  const c = getBinanceCoin(coin);
  if (!c) return [];
  return Object.values(c)
    .filter(n => n.withdrawEnable && n.depositEnable)
    .sort((a, b) => a.withdrawFee - b.withdrawFee);
}

/** Full dataset (all coins, all networks). */
export function getAllBinanceData(): BinanceData {
  return binanceData;
}

/** Metadata about the last fetch. */
export function getBinanceFetchStatus(): { coins: number; fetchedAt: Date | null; file: string } {
  return {
    coins:       Object.keys(binanceData).length,
    fetchedAt:   lastFetchedAt,
    file:        DATA_FILE,
  };
}

// ── Service start ──────────────────────────────────────────────────────────────

export function startBinanceDataService(): void {
  // Load from disk immediately (zero-latency on restart)
  loadFromDisk();
  // Then refresh from API in background
  void fetchAndSaveBinance();
  setInterval(() => void fetchAndSaveBinance(), REFRESH_MS);
}
