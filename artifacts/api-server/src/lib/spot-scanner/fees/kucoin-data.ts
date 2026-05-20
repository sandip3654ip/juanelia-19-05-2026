/**
 * KuCoin Exchange Fee Data
 * ─────────────────────────
 * Fetches the complete public KuCoin coin/network table and persists it to disk.
 * Refreshes every 4 hours. Loads from disk on startup for zero-latency boot.
 *
 * Saved to:  data/kucoin-fees.json
 * Endpoint:  https://api.kucoin.com/api/v3/currencies  (2 194 coins, no auth)
 *
 * Per-chain fields captured:
 *   chainName        — network display id (e.g. "ERC20", "BEP20", "SOL", "ARBITRUM")
 *   chainId          — KuCoin internal chain slug (e.g. "eth", "bsc", "sol")
 *   withdrawFee      — flat withdrawal fee in coin units  (withdrawalMinFee)
 *   withdrawFeeRate  — percentage withdrawal fee rate     (0 = flat fee only)
 *   minWithdraw      — minimum withdrawal amount         (withdrawalMinSize)
 *   minDeposit       — minimum deposit amount            (depositMinSize, may be null)
 *   maxWithdraw      — maximum withdrawal amount         (null = no limit)
 *   depositFee       — always 0 on KuCoin
 *   withdrawEnable   — isWithdrawEnabled
 *   depositEnable    — isDepositEnabled
 *   contractAddress  — on-chain contract address (empty string if native)
 *   requiresMemo     — needTag: whether a memo/tag is required
 */

import fs   from "fs";
import path from "path";
import { logger } from "../../logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface KucoinNetworkEntry {
  /** Network display name as KuCoin reports it, e.g. "ERC20", "BEP20", "SOL" */
  chainName:       string;
  /** KuCoin internal chain slug, e.g. "eth", "bsc", "sol", "arbitrum" */
  chainId:         string;
  /** Flat withdrawal fee in the coin's own unit */
  withdrawFee:     number;
  /** Percentage-based withdrawal fee rate (0 = flat fee only) */
  withdrawFeeRate: number;
  /** Minimum withdrawal amount in coin units */
  minWithdraw:     number;
  /** Minimum deposit amount in coin units (null if KuCoin doesn't specify) */
  minDeposit:      number | null;
  /** Maximum withdrawal amount in coin units (null = no limit) */
  maxWithdraw:     number | null;
  /** Deposit fee — always 0 on KuCoin */
  depositFee:      number;
  withdrawEnable:  boolean;
  depositEnable:   boolean;
  /** On-chain contract address for this coin on this network (empty string if native) */
  contractAddress: string;
  /** Whether a memo / destination tag is required alongside the address */
  requiresMemo:    boolean;
}

/** Per-coin data: chainName → NetworkEntry */
export type KucoinCoinData = Record<string, KucoinNetworkEntry>;

/** Full dataset: coin-symbol → CoinData */
export type KucoinData = Record<string, KucoinCoinData>;

// ── File path ───────────────────────────────────────────────────────────────

const DATA_DIR  = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "kucoin-fees.json");

const FETCH_URL  = "https://api.kucoin.com/api/v3/currencies";
const REFRESH_MS = 60_000; // 1 minute

// ── In-memory cache ─────────────────────────────────────────────────────────

let kucoinData: KucoinData = {};
let lastFetchedAt: Date | null = null;

// ── Disk helpers ─────────────────────────────────────────────────────────────

function loadFromDisk(): boolean {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    const raw  = fs.readFileSync(DATA_FILE, "utf8");
    const json = JSON.parse(raw) as { fetchedAt: string; data: KucoinData };
    kucoinData    = json.data;
    lastFetchedAt = new Date(json.fetchedAt);
    logger.info(
      { coins: Object.keys(kucoinData).length, file: DATA_FILE },
      "kucoin fees loaded from disk",
    );
    return true;
  } catch {
    return false;
  }
}

function saveToDisk(data: KucoinData): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ fetchedAt: new Date().toISOString(), data }, null, 2);
    fs.writeFileSync(DATA_FILE, payload, "utf8");
  } catch (err) {
    logger.warn({ err: String(err) }, "failed to save kucoin fees to disk");
  }
}

// ── KuCoin API response types ────────────────────────────────────────────────

interface KucoinApiChain {
  chainName:        string;
  chainId:          string;
  withdrawalMinFee: string;   // flat fee
  withdrawFeeRate:  string;   // pct rate (usually "0")
  withdrawalMinSize: string;  // min withdrawal
  depositMinSize:   string | null;
  maxWithdraw:      number | null;
  maxDeposit:       number | null;
  isWithdrawEnabled: boolean;
  isDepositEnabled:  boolean;
  contractAddress:  string;
  needTag:          boolean;
}

interface KucoinApiCoin {
  currency: string;
  chains:   KucoinApiChain[];
}

interface KucoinApiResponse {
  code: string;
  data: KucoinApiCoin[];
}

// ── Fetch ─────────────────────────────────────────────────────────────────

export async function fetchAndSaveKucoin(): Promise<void> {
  try {
    const res = await fetch(FETCH_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as KucoinApiResponse;
    if (body.code !== "200000" || !Array.isArray(body.data)) {
      throw new Error(`unexpected response: code=${body.code}`);
    }

    const newData: KucoinData = {};
    let totalNetworks = 0;

    for (const coin of body.data) {
      const symbol = coin.currency.toUpperCase();
      if (!coin.chains?.length) continue;

      newData[symbol] = {};

      for (const chain of coin.chains) {
        const chainKey = chain.chainName; // keep raw name; normalisation happens at query time
        newData[symbol][chainKey] = {
          chainName:       chain.chainName,
          chainId:         chain.chainId,
          withdrawFee:     parseFloat(chain.withdrawalMinFee ?? "0") || 0,
          withdrawFeeRate: parseFloat(chain.withdrawFeeRate  ?? "0") || 0,
          minWithdraw:     parseFloat(chain.withdrawalMinSize ?? "0") || 0,
          minDeposit:      chain.depositMinSize != null ? (parseFloat(chain.depositMinSize) || 0) : null,
          maxWithdraw:     chain.maxWithdraw ?? null,
          depositFee:      0,   // KuCoin never charges deposit fees
          withdrawEnable:  chain.isWithdrawEnabled,
          depositEnable:   chain.isDepositEnabled,
          contractAddress: chain.contractAddress ?? "",
          requiresMemo:    chain.needTag ?? false,
        };
        totalNetworks++;
      }
    }

    kucoinData    = newData;
    lastFetchedAt = new Date();

    saveToDisk(newData);

    logger.info(
      { coins: Object.keys(newData).length, networks: totalNetworks },
      "kucoin fees fetched and saved",
    );
  } catch (err) {
    logger.error({ err: String(err) }, "failed to fetch kucoin fees");
  }
}

// ── Public accessors ──────────────────────────────────────────────────────────

/** All network data for one coin, keyed by chainName. Null if coin unknown. */
export function getKucoinCoin(coin: string): KucoinCoinData | null {
  return kucoinData[coin.toUpperCase()] ?? null;
}

/** All withdrawal-enabled networks for a coin, sorted cheapest flat-fee first. */
export function getKucoinWithdrawNetworks(coin: string): KucoinNetworkEntry[] {
  const c = getKucoinCoin(coin);
  if (!c) return [];
  return Object.values(c)
    .filter(n => n.withdrawEnable)
    .sort((a, b) => a.withdrawFee - b.withdrawFee);
}

/** All deposit-enabled networks for a coin. */
export function getKucoinDepositNetworks(coin: string): KucoinNetworkEntry[] {
  const c = getKucoinCoin(coin);
  if (!c) return [];
  return Object.values(c).filter(n => n.depositEnable);
}

/**
 * Networks where BOTH withdrawal AND deposit are enabled,
 * sorted cheapest flat-fee first.
 */
export function getKucoinBidirectionalNetworks(coin: string): KucoinNetworkEntry[] {
  const c = getKucoinCoin(coin);
  if (!c) return [];
  return Object.values(c)
    .filter(n => n.withdrawEnable && n.depositEnable)
    .sort((a, b) => a.withdrawFee - b.withdrawFee);
}

/** Full dataset (all coins, all networks). */
export function getAllKucoinData(): KucoinData {
  return kucoinData;
}

/** Metadata about the last fetch. */
export function getKucoinFetchStatus(): { coins: number; fetchedAt: Date | null; file: string } {
  return {
    coins:     Object.keys(kucoinData).length,
    fetchedAt: lastFetchedAt,
    file:      DATA_FILE,
  };
}

// ── Service start ──────────────────────────────────────────────────────────────

export function startKucoinDataService(): void {
  // Load from disk immediately (zero-latency on restart)
  loadFromDisk();
  // Then refresh from API in background
  void fetchAndSaveKucoin();
  setInterval(() => void fetchAndSaveKucoin(), REFRESH_MS);
}
