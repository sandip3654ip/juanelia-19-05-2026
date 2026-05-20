/**
 * Bitget Exchange Fee Data
 * ─────────────────────────
 * Fetches the complete public Bitget coin/network table and persists it to disk.
 * Refreshes every 4 hours. Loads from disk on startup for zero-latency boot.
 *
 * Saved to:  data/bitget-fees.json
 * Endpoint:  https://api.bitget.com/api/v2/spot/public/coins  (2 060 coins, no auth)
 *
 * Per-chain fields captured:
 *   chain              — network id as Bitget reports it (e.g. "ETH", "BEP20", "ArbitrumOne")
 *   withdrawFee        — flat withdrawal fee in coin units
 *   extraWithdrawFee   — additional withdrawal fee (usually 0)
 *   minWithdraw        — minimum withdrawal amount
 *   minDeposit         — minimum deposit amount
 *   depositFee         — always 0 on Bitget
 *   withdrawEnable     — withdrawable === "true"
 *   depositEnable      — rechargeable === "true"
 *   contractAddress    — on-chain contract address (null if native)
 *   requiresMemo       — needTag === "true"
 *   congestion         — "normal" | "high" (network congestion status)
 */

import fs   from "fs";
import path from "path";
import { logger } from "../../logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BitgetNetworkEntry {
  /** Network id as Bitget reports it, e.g. "ETH", "BEP20", "ArbitrumOne", "SOL" */
  chain:            string;
  /** Flat withdrawal fee in the coin's own unit */
  withdrawFee:      number;
  /** Extra withdrawal fee (almost always 0) */
  extraWithdrawFee: number;
  /** Minimum withdrawal amount in coin units */
  minWithdraw:      number;
  /** Minimum deposit amount in coin units */
  minDeposit:       number;
  /** Deposit fee — always 0 on Bitget */
  depositFee:       number;
  withdrawEnable:   boolean;
  depositEnable:    boolean;
  /** On-chain contract address (null if native asset) */
  contractAddress:  string | null;
  /** Whether a memo / destination tag is required */
  requiresMemo:     boolean;
  /** Network congestion status: "normal" | "high" */
  congestion:       string;
}

/** Per-coin data: chain → NetworkEntry */
export type BitgetCoinData = Record<string, BitgetNetworkEntry>;

/** Full dataset: coin-symbol → CoinData */
export type BitgetData = Record<string, BitgetCoinData>;

// ── File path ───────────────────────────────────────────────────────────────

const DATA_DIR  = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "bitget-fees.json");

const FETCH_URL  = "https://api.bitget.com/api/v2/spot/public/coins";
const REFRESH_MS = 60_000; // 1 minute

// ── In-memory cache ─────────────────────────────────────────────────────────

let bitgetData: BitgetData = {};
let lastFetchedAt: Date | null = null;

// ── Disk helpers ──────────────────────────────────────────────────────────────

function loadFromDisk(): boolean {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    const raw  = fs.readFileSync(DATA_FILE, "utf8");
    const json = JSON.parse(raw) as { fetchedAt: string; data: BitgetData };
    bitgetData    = json.data;
    lastFetchedAt = new Date(json.fetchedAt);
    logger.info(
      { coins: Object.keys(bitgetData).length, file: DATA_FILE },
      "bitget fees loaded from disk",
    );
    return true;
  } catch {
    return false;
  }
}

function saveToDisk(data: BitgetData): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ fetchedAt: new Date().toISOString(), data }, null, 2);
    fs.writeFileSync(DATA_FILE, payload, "utf8");
  } catch (err) {
    logger.warn({ err: String(err) }, "failed to save bitget fees to disk");
  }
}

// ── Bitget API response types ─────────────────────────────────────────────────

interface BitgetApiChain {
  chain:             string;
  needTag:           string;   // "true" | "false"
  withdrawable:      string;   // "true" | "false"
  rechargeable:      string;   // "true" | "false"
  withdrawFee:       string;
  extraWithdrawFee:  string;
  minDepositAmount:  string;
  minWithdrawAmount: string;
  contractAddress:   string | null;
  congestion:        string;
}

interface BitgetApiCoin {
  coin:   string;
  chains: BitgetApiChain[];
}

interface BitgetApiResponse {
  code: string;
  data: BitgetApiCoin[];
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function fetchAndSaveBitget(): Promise<void> {
  try {
    const res = await fetch(FETCH_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as BitgetApiResponse;
    if (body.code !== "00000" || !Array.isArray(body.data)) {
      throw new Error(`unexpected response: code=${body.code}`);
    }

    const newData: BitgetData = {};
    let totalNetworks = 0;

    for (const coin of body.data) {
      const symbol = coin.coin.toUpperCase();
      if (!coin.chains?.length) continue;

      newData[symbol] = {};

      for (const chain of coin.chains) {
        // Use raw chain name as key; normalisation happens at query time
        newData[symbol][chain.chain] = {
          chain:            chain.chain,
          withdrawFee:      parseFloat(chain.withdrawFee       ?? "0") || 0,
          extraWithdrawFee: parseFloat(chain.extraWithdrawFee  ?? "0") || 0,
          minWithdraw:      parseFloat(chain.minWithdrawAmount ?? "0") || 0,
          minDeposit:       parseFloat(chain.minDepositAmount  ?? "0") || 0,
          depositFee:       0,   // Bitget never charges deposit fees
          withdrawEnable:   chain.withdrawable  === "true",
          depositEnable:    chain.rechargeable  === "true",
          contractAddress:  chain.contractAddress ?? null,
          requiresMemo:     chain.needTag === "true",
          congestion:       chain.congestion ?? "normal",
        };
        totalNetworks++;
      }
    }

    bitgetData    = newData;
    lastFetchedAt = new Date();

    saveToDisk(newData);

    logger.info(
      { coins: Object.keys(newData).length, networks: totalNetworks },
      "bitget fees fetched and saved",
    );
  } catch (err) {
    logger.error({ err: String(err) }, "failed to fetch bitget fees");
  }
}

// ── Public accessors ───────────────────────────────────────────────────────────

/** All network data for one coin, keyed by chain name. Null if coin unknown. */
export function getBitgetCoin(coin: string): BitgetCoinData | null {
  return bitgetData[coin.toUpperCase()] ?? null;
}

/** All withdrawal-enabled networks for a coin, sorted cheapest flat-fee first. */
export function getBitgetWithdrawNetworks(coin: string): BitgetNetworkEntry[] {
  const c = getBitgetCoin(coin);
  if (!c) return [];
  return Object.values(c)
    .filter(n => n.withdrawEnable)
    .sort((a, b) => a.withdrawFee - b.withdrawFee);
}

/** All deposit-enabled networks for a coin. */
export function getBitgetDepositNetworks(coin: string): BitgetNetworkEntry[] {
  const c = getBitgetCoin(coin);
  if (!c) return [];
  return Object.values(c).filter(n => n.depositEnable);
}

/**
 * Networks where BOTH withdrawal AND deposit are enabled,
 * sorted cheapest flat-fee first.
 */
export function getBitgetBidirectionalNetworks(coin: string): BitgetNetworkEntry[] {
  const c = getBitgetCoin(coin);
  if (!c) return [];
  return Object.values(c)
    .filter(n => n.withdrawEnable && n.depositEnable)
    .sort((a, b) => a.withdrawFee - b.withdrawFee);
}

/** Full dataset (all coins, all networks). */
export function getAllBitgetData(): BitgetData {
  return bitgetData;
}

/** Metadata about the last fetch. */
export function getBitgetFetchStatus(): { coins: number; fetchedAt: Date | null; file: string } {
  return {
    coins:     Object.keys(bitgetData).length,
    fetchedAt: lastFetchedAt,
    file:      DATA_FILE,
  };
}

// ── Service start ──────────────────────────────────────────────────────────────

export function startBitgetDataService(): void {
  // Load from disk immediately (zero-latency on restart)
  loadFromDisk();
  // Then refresh from API in background
  void fetchAndSaveBitget();
  setInterval(() => void fetchAndSaveBitget(), REFRESH_MS);
}
