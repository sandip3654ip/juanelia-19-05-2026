/**
 * Bybit Exchange Fee Data
 * ─────────────────────────
 * Deposit data:    fetched from public API, 903 coins  → data/bybit-fees.json
 * Withdrawal data: NO public API (auth required)       → embedded static table
 *
 * Endpoint (deposit): https://api.bybit.com/v5/asset/deposit/query-allowed-list
 *
 * Deposit fields (per chain):
 *   chain           — Bybit chain id (e.g. "BTC", "ETH", "BSC", "ARBI")
 *   chainType       — human-readable name (e.g. "Arbitrum One", "BSC (BEP20)")
 *   minDeposit      — minimum deposit amount in coin units
 *   blockConfirms   — required confirmation count
 *   depositFee      — always 0 on Bybit
 *   depositEnable   — always true (only deposit-enabled chains are listed)
 *
 * Withdrawal fields (static, ~100 coins):
 *   network         — normalised network id
 *   withdrawFee     — flat fee in coin units
 *   minWithdraw     — minimum withdrawal amount
 *   withdrawEnable  — true (static; actual state may vary)
 *   source          — "static" (not from live API)
 *
 * NOTE: Bybit's /v5/asset/coin/query-info (which includes withdrawal fees)
 *       requires HMAC-signed authentication and cannot be called without
 *       user-provided API credentials. The static table below covers the
 *       ~100 most-traded coins and is manually maintained.
 */

import crypto from "crypto";
import fs   from "fs";
import path from "path";
import { logger } from "../../logger.js";

const API_KEY    = process.env.BYBIT_API_KEY    ?? "";
const API_SECRET = process.env.BYBIT_API_SECRET ?? "";
const RECV_WINDOW = "20000";

function signBybit(queryString: string): Record<string, string> {
  const ts   = Date.now().toString();
  const msg  = ts + API_KEY + RECV_WINDOW + queryString;
  const sign = crypto.createHmac("sha256", API_SECRET).update(msg).digest("hex");
  return {
    "X-BAPI-API-KEY":     API_KEY,
    "X-BAPI-TIMESTAMP":   ts,
    "X-BAPI-SIGN":        sign,
    "X-BAPI-RECV-WINDOW": RECV_WINDOW,
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface BybitDepositEntry {
  /** Bybit chain id, e.g. "BTC", "ETH", "BSC", "ARBI", "ZKV2" */
  chain:           string;
  /** Human-readable chain name from Bybit, e.g. "Arbitrum One" */
  chainType:       string;
  /** Minimum deposit amount in coin units */
  minDeposit:      number;
  /** Required block confirmations before credit */
  blockConfirms:   number;
  /** Deposit fee — always 0 on Bybit */
  depositFee:      number;
  /** Always true: only enabled deposit chains are in the list */
  depositEnable:   boolean;
  /** Contract address on this chain (null = native asset or unknown) */
  contractAddress: string | null;
}

export interface BybitWithdrawalEntry {
  /** Normalised network id used for cross-exchange matching */
  network:         string;
  /** Flat withdrawal fee in coin units */
  withdrawFee:     number;
  /** Minimum withdrawal amount in coin units */
  minWithdraw:     number;
  withdrawEnable:  boolean;
  /** Contract address on this network (null = native asset or unknown) */
  contractAddress: string | null;
  /** "api" = from live coin-info API; "static" = manually maintained table */
  source:          "api" | "static";
}

export interface BybitCoinData {
  /** Deposit chains (from live API — refreshed every 30min) */
  deposit:     BybitDepositEntry[];
  /** Withdrawal networks — multiple networks per coin, cheapest picked by matcher */
  withdrawals: BybitWithdrawalEntry[];
}

/** Full dataset: coin-symbol → CoinData */
export type BybitData = Record<string, BybitCoinData>;

// ── File path ─────────────────────────────────────────────────────────────────

const DATA_DIR  = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "bybit-fees.json");

const DEPOSIT_URL = "https://api.bybit.com/v5/asset/deposit/query-allowed-list";
const REFRESH_MS  = 60_000; // 1 minute

// ── Static withdrawal table (~100 coins, manually maintained) ────────────────
//
// Source: Bybit web UI + Binance public API as cross-reference.
// Bybit's /v5/asset/coin/query-info requires HMAC auth — not publicly available.
// Network ids use the same canonical names as the rest of this codebase.
//
const BYBIT_WITHDRAWAL_STATIC: Record<string, { network: string; withdrawFee: number; minWithdraw: number }> = {
  BTC:     { network: "BTC",        withdrawFee: 0.00050,   minWithdraw: 0.001   },
  ETH:     { network: "ARBITRUM",   withdrawFee: 0.0010,    minWithdraw: 0.005   },
  SOL:     { network: "SOL",        withdrawFee: 0.01,      minWithdraw: 0.02    },
  BNB:     { network: "BEP20",      withdrawFee: 0.00025,   minWithdraw: 0.01    },
  XRP:     { network: "XRP",        withdrawFee: 0.25,      minWithdraw: 25      },
  ADA:     { network: "ADA",        withdrawFee: 1.0,       minWithdraw: 10      },
  DOGE:    { network: "DOGE",       withdrawFee: 5.0,       minWithdraw: 50      },
  AVAX:    { network: "AVAX",       withdrawFee: 0.01,      minWithdraw: 0.1     },
  MATIC:   { network: "MATIC",      withdrawFee: 0.1,       minWithdraw: 10      },
  POL:     { network: "MATIC",      withdrawFee: 0.1,       minWithdraw: 10      },
  DOT:     { network: "DOT",        withdrawFee: 0.08,      minWithdraw: 1       },
  LINK:    { network: "BEP20",      withdrawFee: 0.05,      minWithdraw: 0.5     },
  LTC:     { network: "LTC",        withdrawFee: 0.001,     minWithdraw: 0.01    },
  BCH:     { network: "BCH",        withdrawFee: 0.0001,    minWithdraw: 0.01    },
  TRX:     { network: "TRC20",      withdrawFee: 1.0,       minWithdraw: 10      },
  ATOM:    { network: "COSMOS",     withdrawFee: 0.1,       minWithdraw: 1       },
  UNI:     { network: "BEP20",      withdrawFee: 0.05,      minWithdraw: 0.5     },
  NEAR:    { network: "NEAR",       withdrawFee: 0.01,      minWithdraw: 0.1     },
  APT:     { network: "APT",        withdrawFee: 0.01,      minWithdraw: 0.1     },
  ARB:     { network: "ARBITRUM",   withdrawFee: 0.1,       minWithdraw: 1       },
  OP:      { network: "OPTIMISM",   withdrawFee: 0.05,      minWithdraw: 0.5     },
  SUI:     { network: "SUI",        withdrawFee: 0.02,      minWithdraw: 0.5     },
  INJ:     { network: "INJ",        withdrawFee: 0.005,     minWithdraw: 0.05    },
  SEI:     { network: "SEI",        withdrawFee: 0.1,       minWithdraw: 1       },
  ENA:     { network: "ERC20",      withdrawFee: 5.0,       minWithdraw: 20      },
  ZRO:     { network: "BEP20",      withdrawFee: 0.1,       minWithdraw: 1       },
  W:       { network: "SOL",        withdrawFee: 0.02,      minWithdraw: 0.5     },
  POPCAT:  { network: "SOL",        withdrawFee: 0.02,      minWithdraw: 0.5     },
  NOT:     { network: "TON",        withdrawFee: 1.0,       minWithdraw: 10      },
  ETC:     { network: "ETC",        withdrawFee: 0.01,      minWithdraw: 0.1     },
  HBAR:    { network: "HBAR",       withdrawFee: 1.0,       minWithdraw: 10      },
  XTZ:     { network: "XTZ",        withdrawFee: 0.2,       minWithdraw: 1       },
  RUNE:    { network: "THORCHAIN",  withdrawFee: 0.02,      minWithdraw: 1       },
  BLUR:    { network: "ERC20",      withdrawFee: 1.5,       minWithdraw: 5       },
  MINA:    { network: "MINA",       withdrawFee: 1.0,       minWithdraw: 1       },
  KSM:     { network: "KSM",        withdrawFee: 0.005,     minWithdraw: 0.05    },
  FIDA:    { network: "SOL",        withdrawFee: 0.1,       minWithdraw: 1       },
  TWT:     { network: "BEP20",      withdrawFee: 1.0,       minWithdraw: 1       },
  CVX:     { network: "ERC20",      withdrawFee: 2.0,       minWithdraw: 1       },
  STG:     { network: "BEP20",      withdrawFee: 5.0,       minWithdraw: 1       },
  SAFE:    { network: "ERC20",      withdrawFee: 0.5,       minWithdraw: 1       },
  DOGS:    { network: "TON",        withdrawFee: 50.0,      minWithdraw: 100     },
  HMSTR:   { network: "TON",        withdrawFee: 1.0,       minWithdraw: 10      },
  MOVR:    { network: "MOONRIVER",  withdrawFee: 0.01,      minWithdraw: 0.1     },
  CYBER:   { network: "BEP20",      withdrawFee: 0.5,       minWithdraw: 1       },
  GALA:    { network: "BEP20",      withdrawFee: 10.0,      minWithdraw: 50      },
  GMT:     { network: "SOL",        withdrawFee: 0.1,       minWithdraw: 1       },
  CHZ:     { network: "CHZ",        withdrawFee: 1.0,       minWithdraw: 10      },
  SAND:    { network: "BEP20",      withdrawFee: 0.5,       minWithdraw: 5       },
  MANA:    { network: "BEP20",      withdrawFee: 0.5,       minWithdraw: 5       },
  AXS:     { network: "BEP20",      withdrawFee: 0.02,      minWithdraw: 0.2     },
  GRT:     { network: "BEP20",      withdrawFee: 1.0,       minWithdraw: 10      },
  CRV:     { network: "ERC20",      withdrawFee: 1.0,       minWithdraw: 5       },
  LDO:     { network: "ERC20",      withdrawFee: 0.5,       minWithdraw: 5       },
  SNX:     { network: "BEP20",      withdrawFee: 0.1,       minWithdraw: 1       },
  MKR:     { network: "ERC20",      withdrawFee: 0.001,     minWithdraw: 0.01    },
  COMP:    { network: "ERC20",      withdrawFee: 0.02,      minWithdraw: 0.1     },
  CAKE:    { network: "BEP20",      withdrawFee: 0.1,       minWithdraw: 1       },
  FTM:     { network: "FTM",        withdrawFee: 0.1,       minWithdraw: 10      },
  S:       { network: "S",          withdrawFee: 0.1,       minWithdraw: 1       },
  XLM:     { network: "XLM",        withdrawFee: 0.1,       minWithdraw: 1       },
  PEPE:    { network: "ERC20",      withdrawFee: 300000.0,  minWithdraw: 1000000 },
  SHIB:    { network: "ERC20",      withdrawFee: 100000.0,  minWithdraw: 500000  },
  FLOKI:   { network: "BEP20",      withdrawFee: 1000.0,    minWithdraw: 5000    },
  BONK:    { network: "SOL",        withdrawFee: 5000.0,    minWithdraw: 10000   },
  ALGO:    { network: "ALGO",       withdrawFee: 0.1,       minWithdraw: 1       },
  ICP:     { network: "ICP",        withdrawFee: 0.0001,    minWithdraw: 0.01    },
  AAVE:    { network: "BEP20",      withdrawFee: 0.02,      minWithdraw: 0.1     },
  TIA:     { network: "CELESTIA",   withdrawFee: 0.01,      minWithdraw: 0.1     },
  STRK:    { network: "STARKNET",   withdrawFee: 0.5,       minWithdraw: 1       },
  JUP:     { network: "SOL",        withdrawFee: 0.02,      minWithdraw: 0.5     },
  STX:     { network: "STX",        withdrawFee: 0.1,       minWithdraw: 1       },
  FIL:     { network: "FIL",        withdrawFee: 0.001,     minWithdraw: 0.01    },
  TON:     { network: "TON",        withdrawFee: 0.03,      minWithdraw: 0.1     },
  MAJOR:   { network: "TON",        withdrawFee: 1.0,       minWithdraw: 10      },
  JTO:     { network: "SOL",        withdrawFee: 0.5,       minWithdraw: 1       },
  RENDER:  { network: "SOL",        withdrawFee: 0.2,       minWithdraw: 0.5     },
  RNDR:    { network: "SOL",        withdrawFee: 0.2,       minWithdraw: 0.5     },
  WIF:     { network: "SOL",        withdrawFee: 1.0,       minWithdraw: 2       },
  TRUMP:   { network: "SOL",        withdrawFee: 0.2,       minWithdraw: 0.5     },
  PYTH:    { network: "SOL",        withdrawFee: 5.0,       minWithdraw: 10      },
  PENDLE:  { network: "BEP20",      withdrawFee: 0.02,      minWithdraw: 0.1     },
  MASK:    { network: "BEP20",      withdrawFee: 0.1,       minWithdraw: 0.5     },
  SUSHI:   { network: "BEP20",      withdrawFee: 0.1,       minWithdraw: 1       },
  "1INCH": { network: "BEP20",      withdrawFee: 0.5,       minWithdraw: 5       },
  PEOPLE:  { network: "BEP20",      withdrawFee: 3.0,       minWithdraw: 30      },
  SOLV:    { network: "BEP20",      withdrawFee: 5.0,       minWithdraw: 20      },
  ANKR:    { network: "BEP20",      withdrawFee: 10.0,      minWithdraw: 100     },
  VET:     { network: "VET",        withdrawFee: 20.0,      minWithdraw: 100     },
  VTHO:    { network: "VET",        withdrawFee: 100.0,     minWithdraw: 1000    },
  ONE:     { network: "ONE",        withdrawFee: 1.0,       minWithdraw: 10      },
  ICX:     { network: "ICX",        withdrawFee: 0.1,       minWithdraw: 1       },
  ZIL:     { network: "ZIL",        withdrawFee: 1.0,       minWithdraw: 10      },
  QTUM:    { network: "QTUM",       withdrawFee: 0.01,      minWithdraw: 0.1     },
  WAVES:   { network: "WAVES",      withdrawFee: 0.01,      minWithdraw: 0.1     },
  THETA:   { network: "THETA",      withdrawFee: 0.15,      minWithdraw: 1       },
  EGLD:    { network: "EGLD",       withdrawFee: 0.001,     minWithdraw: 0.01    },
  FLOW:    { network: "FLOW",       withdrawFee: 0.01,      minWithdraw: 0.1     },
  ROSE:    { network: "ROSE",       withdrawFee: 0.1,       minWithdraw: 1       },
  AXL:     { network: "AXL",        withdrawFee: 0.05,      minWithdraw: 0.5     },
  DYDX:    { network: "DYDX",       withdrawFee: 0.02,      minWithdraw: 0.1     },
  GMX:     { network: "ARBITRUM",   withdrawFee: 0.02,      minWithdraw: 0.1     },
  MAGIC:   { network: "ARBITRUM",   withdrawFee: 1.5,       minWithdraw: 5       },
  ORDI:    { network: "BTC",        withdrawFee: 1.2,       minWithdraw: 3       },
  SATS:    { network: "BTC",        withdrawFee: 500000.0,  minWithdraw: 2000000 },
  WLD:     { network: "WLD",        withdrawFee: 0.1,       minWithdraw: 0.5     },
  QNT:     { network: "ERC20",      withdrawFee: 0.01,      minWithdraw: 0.05    },
  ENS:     { network: "ERC20",      withdrawFee: 0.1,       minWithdraw: 0.5     },
  IMX:     { network: "ERC20",      withdrawFee: 4.0,       minWithdraw: 10      },
  RPL:     { network: "ERC20",      withdrawFee: 0.5,       minWithdraw: 2       },
  SSV:     { network: "ERC20",      withdrawFee: 0.3,       minWithdraw: 1       },
  WBTC:    { network: "ERC20",      withdrawFee: 0.00001,   minWithdraw: 0.0001  },
  YFI:     { network: "BEP20",      withdrawFee: 0.00001,   minWithdraw: 0.0001  },
  GRASS:   { network: "SOL",        withdrawFee: 0.5,       minWithdraw: 2       },
  EIGEN:   { network: "ERC20",      withdrawFee: 3.5,       minWithdraw: 10      },
  JUV:     { network: "CHZ",        withdrawFee: 0.5,       minWithdraw: 5       },
  UMA:     { network: "ERC20",      withdrawFee: 1.5,       minWithdraw: 5       },
  TNSR:    { network: "SOL",        withdrawFee: 5.0,       minWithdraw: 10      },
  KMNO:    { network: "SOL",        withdrawFee: 10.0,      minWithdraw: 50      },
  SPELL:   { network: "ERC20",      withdrawFee: 4000.0,    minWithdraw: 10000   },
  BREV:    { network: "BEP20",      withdrawFee: 0.2,       minWithdraw: 1       },
  FOGO:    { network: "FOGO",       withdrawFee: 0.01,      minWithdraw: 0.1     },
  HAEDAL:  { network: "BEP20",      withdrawFee: 0.5,       minWithdraw: 2       },
  ZKP:     { network: "BEP20",      withdrawFee: 0.3,       minWithdraw: 1       },
  ASTER:   { network: "BEP20",      withdrawFee: 0.05,      minWithdraw: 0.5     },
  CFG:     { network: "ERC20",      withdrawFee: 2.5,       minWithdraw: 10      },
  SUN:     { network: "TRC20",      withdrawFee: 1000.0,    minWithdraw: 5000    },
  JST:     { network: "TRC20",      withdrawFee: 50.0,      minWithdraw: 200     },
  ENJ:     { network: "ENJ",        withdrawFee: 0.001,     minWithdraw: 0.01    },
  LUNA:    { network: "LUNA",       withdrawFee: 0.1,       minWithdraw: 1       },
  STRAX:   { network: "STRAX",      withdrawFee: 0.01,      minWithdraw: 0.1     },
  MTL:     { network: "MTL",        withdrawFee: 0.1,       minWithdraw: 1       },
  FLUX:    { network: "BEP20",      withdrawFee: 0.5,       minWithdraw: 2       },
  ASTR:    { network: "ASTR",       withdrawFee: 0.5,       minWithdraw: 5       },
  RONIN:   { network: "RONIN",      withdrawFee: 0.01,      minWithdraw: 0.1     },
  ONDO:    { network: "ERC20",      withdrawFee: 2.0,       minWithdraw: 5       },
  VIRTUAL: { network: "BASE",       withdrawFee: 0.5,       minWithdraw: 2       },
  PENGU:   { network: "SOL",        withdrawFee: 20.0,      minWithdraw: 100     },
  DOOD:    { network: "SOL",        withdrawFee: 1.0,       minWithdraw: 5       },
  GOAT:    { network: "SOL",        withdrawFee: 5.0,       minWithdraw: 20      },
  MEW:     { network: "SOL",        withdrawFee: 5.0,       minWithdraw: 20      },
  PNUT:    { network: "SOL",        withdrawFee: 2.0,       minWithdraw: 10      },
  AI16Z:   { network: "SOL",        withdrawFee: 2.0,       minWithdraw: 10      },
  ACT:     { network: "SOL",        withdrawFee: 5.0,       minWithdraw: 20      },
  DRIFT:   { network: "SOL",        withdrawFee: 2.0,       minWithdraw: 10      },
  HYPE:    { network: "HYPE",       withdrawFee: 0.5,       minWithdraw: 2       },
  LAYER:   { network: "SOL",        withdrawFee: 2.0,       minWithdraw: 10      },
  MOVE:    { network: "MOVEMENT",   withdrawFee: 0.1,       minWithdraw: 1       },
  COOKIE:  { network: "SOL",        withdrawFee: 5.0,       minWithdraw: 20      },
  NEIROCTO:{ network: "SOL",        withdrawFee: 5.0,       minWithdraw: 20      },
};

// ── In-memory cache ─────────────────────────────────────────────────────────

let bybitData: BybitData = {};
let lastFetchedAt: Date | null = null;

// ── Disk helpers ──────────────────────────────────────────────────────────────

function loadFromDisk(): boolean {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    const raw  = fs.readFileSync(DATA_FILE, "utf8");
    const json = JSON.parse(raw) as { fetchedAt: string; data: BybitData };
    bybitData     = json.data;
    lastFetchedAt = new Date(json.fetchedAt);
    logger.info(
      { coins: Object.keys(bybitData).length, file: DATA_FILE },
      "bybit fees loaded from disk",
    );
    return true;
  } catch {
    return false;
  }
}

function saveToDisk(data: BybitData, withdrawalSource: "api" | "static"): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify(
      { fetchedAt: new Date().toISOString(), depositSource: "api", withdrawalSource, data },
      null,
      2,
    );
    fs.writeFileSync(DATA_FILE, payload, "utf8");
  } catch (err) {
    logger.warn({ err: String(err) }, "failed to save bybit fees to disk");
  }
}

// ── Bybit public deposit API types ───────────────────────────────────────────

interface BybitApiEntry {
  coin:                string;
  chain:               string;
  coinShowName:        string;
  chainType:           string;
  blockConfirmNumber:  number;
  minDepositAmount:    string;
}

interface BybitApiResponse {
  retCode: number;
  result?: { configList: BybitApiEntry[] };
}

// ── Bybit coin-info API types (authenticated) ─────────────────────────────────

interface BybitCoinInfoChain {
  chain:           string;
  chainType:       string;
  chainDeposit:    string;   // "1" = enabled, "0" = disabled
  chainWithdraw:   string;   // "1" = enabled, "0" = disabled
  withdrawFee:     string;
  depositMin:      string;
  withdrawMin:     string;
  contractAddress: string;   // empty string for native assets
}

interface BybitCoinInfoRow { coin: string; chains: BybitCoinInfoChain[] }
interface BybitCoinInfoResponse {
  retCode: number;
  result?: { rows: BybitCoinInfoRow[] };
}

// Parsed coin-info: COIN → chain-id → per-chain data
type ParsedCoinInfo = Map<string, Map<string, {
  contractAddress: string | null;
  withdrawFee:     number;
  minWithdraw:     number;
  withdrawEnable:  boolean;
  depositEnable:   boolean;
}>>;

// ── Authenticated coin-info fetch (withdrawal fees + contract addresses) ──────

const COIN_INFO_URL = "https://api.bybit.com/v5/asset/coin/query-info";

async function fetchBybitCoinInfo(): Promise<ParsedCoinInfo | null> {
  if (!API_KEY || !API_SECRET) return null;
  try {
    const res = await fetch(COIN_INFO_URL, {
      headers: { ...signBybit(""), "User-Agent": "Mozilla/5.0" },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as BybitCoinInfoResponse;
    if (body.retCode !== 0 || !body.result?.rows) {
      throw new Error(`unexpected retCode=${body.retCode}`);
    }

    const result: ParsedCoinInfo = new Map();
    for (const row of body.result.rows) {
      const coin   = row.coin.toUpperCase();
      const chains = new Map<string, { contractAddress: string | null; withdrawFee: number; minWithdraw: number; withdrawEnable: boolean; depositEnable: boolean }>();
      for (const c of row.chains) {
        const addr = c.contractAddress.trim();
        chains.set(c.chain, {
          contractAddress: addr === "" ? null : addr.toLowerCase(),
          withdrawFee:     parseFloat(c.withdrawFee) || 0,
          minWithdraw:     parseFloat(c.withdrawMin) || 0,
          withdrawEnable:  c.chainWithdraw === "1",
          depositEnable:   c.chainDeposit  === "1",
        });
      }
      result.set(coin, chains);
    }

    logger.info(
      { coins: result.size },
      "bybit coin-info fetched (live withdrawal fees + contract addresses)",
    );
    return result;
  } catch (err) {
    logger.warn({ err: String(err) }, "bybit coin-info fetch failed — using static withdrawal table");
    return null;
  }
}

// ── Build combined dataset ────────────────────────────────────────────────────

function buildDataset(
  depositList: BybitApiEntry[],
  coinInfo:    ParsedCoinInfo | null,
): BybitData {
  // Group public deposit entries by coin
  const depositByCoin = new Map<string, BybitDepositEntry[]>();
  for (const e of depositList) {
    const sym = e.coin.toUpperCase();
    if (!depositByCoin.has(sym)) depositByCoin.set(sym, []);
    const chainInfo = coinInfo?.get(sym)?.get(e.chain);
    depositByCoin.get(sym)!.push({
      chain:           e.chain,
      chainType:       e.chainType,
      minDeposit:      parseFloat(e.minDepositAmount) || 0,
      blockConfirms:   e.blockConfirmNumber,
      depositFee:      0,
      // Use coin-info API's depositEnable if available (authoritative);
      // public deposit API only returns enabled chains, so default is true.
      depositEnable:   chainInfo?.depositEnable ?? true,
      contractAddress: chainInfo?.contractAddress ?? null,
    });
  }

  // Determine all coins: union of deposit API, coin-info API, and static table
  const allCoins = new Set<string>([
    ...depositByCoin.keys(),
    ...(coinInfo ? coinInfo.keys() : []),
    ...Object.keys(BYBIT_WITHDRAWAL_STATIC),
  ]);

  const result: BybitData = {};
  for (const coin of allCoins) {
    const depositChains = depositByCoin.get(coin) ?? [];

    // Withdrawals: prefer live coin-info data, fall back to static table
    let withdrawals: BybitWithdrawalEntry[] = [];

    if (coinInfo?.has(coin)) {
      const chains = coinInfo.get(coin)!;
      for (const [chain, info] of chains) {
        if (!info.withdrawEnable) continue;
        withdrawals.push({
          network:         chain,   // raw chain id — normalizeNetwork applied in matcher
          withdrawFee:     info.withdrawFee,
          minWithdraw:     info.minWithdraw,
          withdrawEnable:  true,
          contractAddress: info.contractAddress,
          source:          "api",
        });
      }
    }

    if (withdrawals.length === 0) {
      const wd = BYBIT_WITHDRAWAL_STATIC[coin];
      if (wd) {
        withdrawals = [{
          network:         wd.network,
          withdrawFee:     wd.withdrawFee,
          minWithdraw:     wd.minWithdraw,
          withdrawEnable:  true,
          contractAddress: null,
          source:          "static",
        }];
      }
    }

    result[coin] = { deposit: depositChains, withdrawals };
  }
  return result;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function fetchAndSaveBybit(): Promise<void> {
  try {
    // 1. Try authenticated coin-info first (withdrawal fees + contract addresses)
    const coinInfo = await fetchBybitCoinInfo();

    // 2. Public deposit API (chain list + confirmations)
    const res = await fetch(DEPOSIT_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as BybitApiResponse;
    if (body.retCode !== 0 || !body.result?.configList?.length) {
      throw new Error(`unexpected response: retCode=${body.retCode}`);
    }

    const newData = buildDataset(body.result.configList, coinInfo);
    bybitData     = newData;
    lastFetchedAt = new Date();

    const depositCoins    = new Set(body.result.configList.map(e => e.coin.toUpperCase())).size;
    const withdrawalSrc   = coinInfo ? "api" : "static";
    const withdrawCoins   = Object.values(newData).filter(c => c.withdrawals.length > 0).length;
    const bothCoins       = Object.values(newData).filter(c => c.deposit.length > 0 && c.withdrawals.length > 0).length;

    saveToDisk(newData, withdrawalSrc);

    logger.info(
      {
        totalCoins:       Object.keys(newData).length,
        depositApiCoins:  depositCoins,
        withdrawalCoins:  withdrawCoins,
        withdrawalSource: withdrawalSrc,
        bothAvailable:    bothCoins,
        depositEntries:   body.result.configList.length,
      },
      "bybit fees fetched and saved",
    );
  } catch (err) {
    logger.error({ err: String(err) }, "failed to fetch bybit deposit data");
  }
}

// ── Public accessors ───────────────────────────────────────────────────────────

/** All data for one coin (deposit chains + withdrawals). Null if coin unknown. */
export function getBybitCoin(coin: string): BybitCoinData | null {
  return bybitData[coin.toUpperCase()] ?? null;
}

/** Deposit-enabled chains for a coin, sorted by minDeposit ascending. */
export function getBybitDepositNetworks(coin: string): BybitDepositEntry[] {
  const c = getBybitCoin(coin);
  if (!c) return [];
  return [...c.deposit]
    .filter(e => e.depositEnable)   // exclude chains disabled per coin-info API
    .sort((a, b) => a.minDeposit - b.minDeposit);
}

/** All withdrawal networks for a coin (sorted by withdrawFee ascending). */
export function getBybitWithdrawNetworks(coin: string): BybitWithdrawalEntry[] {
  const c = getBybitCoin(coin);
  if (!c) return [];
  return [...c.withdrawals].sort((a, b) => a.withdrawFee - b.withdrawFee);
}

/** First (cheapest) withdrawal entry for a coin, or null if unknown. */
export function getBybitWithdrawalEntry(coin: string): BybitWithdrawalEntry | null {
  return getBybitWithdrawNetworks(coin)[0] ?? null;
}

/** All coins that have BOTH deposit chain data AND withdrawal data. */
export function getBybitFullCoverageCoins(): string[] {
  return Object.entries(bybitData)
    .filter(([, c]) => c.deposit.length > 0 && c.withdrawals.length > 0)
    .map(([sym]) => sym);
}

/** Full dataset (all coins). */
export function getAllBybitData(): BybitData {
  return bybitData;
}

/** Metadata about the last fetch. */
export function getBybitFetchStatus(): {
  coins: number;
  depositApiCoins: number;
  withdrawalCoins: number;
  bothAvailable: number;
  fetchedAt: Date | null;
  file: string;
} {
  const depositCoins    = Object.values(bybitData).filter(c => c.deposit.length > 0).length;
  const withdrawalCoins = Object.values(bybitData).filter(c => c.withdrawals.length > 0).length;
  const bothCoins       = Object.values(bybitData).filter(c => c.deposit.length > 0 && c.withdrawals.length > 0).length;
  return {
    coins:           Object.keys(bybitData).length,
    depositApiCoins: depositCoins,
    withdrawalCoins,
    bothAvailable:   bothCoins,
    fetchedAt:       lastFetchedAt,
    file:            DATA_FILE,
  };
}

// ── Service start ──────────────────────────────────────────────────────────────

export function startBybitDataService(): void {
  const diskLoaded = loadFromDisk();

  if (!diskLoaded) {
    // Build with static-only data before first API fetch completes
    bybitData = buildDataset([], null);
  }

  void fetchAndSaveBybit();
  setInterval(() => void fetchAndSaveBybit(), REFRESH_MS);
}
