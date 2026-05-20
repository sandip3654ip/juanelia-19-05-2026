import crypto from "node:crypto";
import { logger } from "../logger";

// ── Types ───────────────────────────────────────────────────────────────────

export interface WalletAsset {
  coin: string;
  free: number;
  locked: number;
  usdtValue: number;
}

export interface ExchangeWallet {
  exchange: string;
  status: "ok" | "error" | "no_key";
  keyConfigured: boolean;
  totalEquityUSDT: number;
  availableUSDT: number;
  assets: WalletAsset[];
  error: string | null;
  fetchedAt: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hmacSha256(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function hmacSha256Base64(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("base64");
}

function noKey(exchange: string): ExchangeWallet {
  return {
    exchange, status: "no_key", keyConfigured: false,
    totalEquityUSDT: 0, availableUSDT: 0, assets: [], error: null,
    fetchedAt: Date.now(),
  };
}

function errWallet(exchange: string, err: unknown): ExchangeWallet {
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn({ exchange, err }, "wallet balance fetch failed");
  return {
    exchange, status: "error", keyConfigured: true,
    totalEquityUSDT: 0, availableUSDT: 0, assets: [], error: msg,
    fetchedAt: Date.now(),
  };
}

const STABLECOINS = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI"]);

// ── Binance ─────────────────────────────────────────────────────────────────

async function fetchBinance(): Promise<ExchangeWallet> {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) return noKey("binance");

  try {
    const ts = Date.now();
    const qs = `timestamp=${ts}&omitZeroBalances=true`;
    const sig = hmacSha256(secret, qs);
    const url = `https://api.binance.com/api/v3/account?${qs}&signature=${sig}`;

    const res = await fetch(url, {
      headers: { "X-MBX-APIKEY": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json() as {
      balances: Array<{ asset: string; free: string; locked: string }>;
    };

    let totalEquityUSDT = 0;
    let availableUSDT = 0;

    const assets: WalletAsset[] = data.balances
      .map((b) => {
        const free   = parseFloat(b.free)   || 0;
        const locked = parseFloat(b.locked) || 0;
        if (free + locked === 0) return null;
        const usdtValue = STABLECOINS.has(b.asset) ? free + locked : 0;
        return { coin: b.asset, free, locked, usdtValue };
      })
      .filter((a): a is WalletAsset => a !== null);

    for (const a of assets) {
      totalEquityUSDT += a.usdtValue;
      if (a.coin === "USDT") availableUSDT = a.free;
    }

    assets.sort((a, b) => b.usdtValue - a.usdtValue || b.free - a.free);

    return {
      exchange: "binance", status: "ok", keyConfigured: true,
      totalEquityUSDT, availableUSDT, assets, error: null, fetchedAt: Date.now(),
    };
  } catch (err) {
    return errWallet("binance", err);
  }
}

// ── Bybit ───────────────────────────────────────────────────────────────────

async function fetchBybit(): Promise<ExchangeWallet> {
  const apiKey = process.env.BYBIT_API_KEY;
  const secret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !secret) return noKey("bybit");

  try {
    const ts    = Date.now().toString();
    const recv  = "10000";
    const qs    = "accountType=UNIFIED";
    const sign  = hmacSha256(secret, ts + apiKey + recv + qs);
    const url   = `https://api.bybit.com/v5/account/wallet-balance?${qs}`;

    const res = await fetch(url, {
      headers: {
        "X-BAPI-API-KEY":     apiKey,
        "X-BAPI-SIGN":        sign,
        "X-BAPI-TIMESTAMP":   ts,
        "X-BAPI-RECV-WINDOW": recv,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as {
      retCode: number;
      retMsg: string;
      result: {
        list: Array<{
          totalEquity: string;
          totalAvailableBalance: string;
          coin: Array<{
            coin: string;
            walletBalance: string;
            locked: string;
            usdValue: string;
            availableToWithdraw: string;
          }>;
        }>;
      };
    };

    if (data.retCode !== 0) throw new Error(data.retMsg);

    const account = data.result.list[0];
    if (!account) throw new Error("No UNIFIED account returned");

    const totalEquityUSDT = parseFloat(account.totalEquity)           || 0;
    const availableUSDT   = parseFloat(account.totalAvailableBalance) || 0;

    const assets: WalletAsset[] = account.coin
      .filter((c) => (parseFloat(c.walletBalance) || 0) > 0)
      .map((c) => ({
        coin:      c.coin,
        free:      parseFloat(c.availableToWithdraw) || 0,
        locked:    parseFloat(c.locked)              || 0,
        usdtValue: parseFloat(c.usdValue)            || 0,
      }))
      .sort((a, b) => b.usdtValue - a.usdtValue);

    return {
      exchange: "bybit", status: "ok", keyConfigured: true,
      totalEquityUSDT, availableUSDT, assets, error: null, fetchedAt: Date.now(),
    };
  } catch (err) {
    return errWallet("bybit", err);
  }
}

// ── KuCoin ──────────────────────────────────────────────────────────────────

async function fetchKucoin(): Promise<ExchangeWallet> {
  const apiKey    = process.env.KUCOIN_API_KEY;
  const secret    = process.env.KUCOIN_API_SECRET;
  const passphrase = process.env.KUCOIN_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) return noKey("kucoin");

  try {
    const ts      = Date.now().toString();
    const method  = "GET";
    const path    = "/api/v1/accounts?type=trade";
    const signStr = ts + method + path;
    const sign    = hmacSha256Base64(secret, signStr);
    const pp      = hmacSha256Base64(secret, passphrase);
    const url     = `https://api.kucoin.com${path}`;

    const res = await fetch(url, {
      headers: {
        "KC-API-KEY":         apiKey,
        "KC-API-SIGN":        sign,
        "KC-API-TIMESTAMP":   ts,
        "KC-API-PASSPHRASE":  pp,
        "KC-API-KEY-VERSION": "2",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as {
      code: string;
      msg?: string;
      data: Array<{ currency: string; balance: string; available: string; holds: string }>;
    };
    if (data.code !== "200000") throw new Error(data.msg ?? `KuCoin error ${data.code}`);

    let totalEquityUSDT = 0;
    let availableUSDT   = 0;

    const assets: WalletAsset[] = (data.data ?? [])
      .filter((a) => (parseFloat(a.balance) || 0) > 0)
      .map((a) => {
        const free   = parseFloat(a.available) || 0;
        const locked = parseFloat(a.holds)     || 0;
        const usdtValue = STABLECOINS.has(a.currency) ? free + locked : 0;
        return { coin: a.currency, free, locked, usdtValue };
      });

    for (const a of assets) {
      totalEquityUSDT += a.usdtValue;
      if (a.coin === "USDT") availableUSDT = a.free;
    }

    assets.sort((a, b) => b.usdtValue - a.usdtValue || b.free - a.free);

    return {
      exchange: "kucoin", status: "ok", keyConfigured: true,
      totalEquityUSDT, availableUSDT, assets, error: null, fetchedAt: Date.now(),
    };
  } catch (err) {
    return errWallet("kucoin", err);
  }
}

// ── Bitget ──────────────────────────────────────────────────────────────────

async function fetchBitget(): Promise<ExchangeWallet> {
  const apiKey    = process.env.BITGET_API_KEY;
  const secret    = process.env.BITGET_API_SECRET;
  const passphrase = process.env.BITGET_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) return noKey("bitget");

  try {
    const ts     = Date.now().toString();
    const method = "GET";
    const path   = "/api/v2/spot/account/assets";
    const sign   = hmacSha256Base64(secret, ts + method + path);
    const url    = `https://api.bitget.com${path}`;

    const res = await fetch(url, {
      headers: {
        "ACCESS-KEY":        apiKey,
        "ACCESS-SIGN":       sign,
        "ACCESS-TIMESTAMP":  ts,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type":      "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as {
      code: string;
      msg: string;
      data: Array<{
        coinName: string;
        available: string;
        frozen: string;
        usdtValue: string;
      }>;
    };
    if (data.code !== "00000") throw new Error(data.msg ?? `Bitget error ${data.code}`);

    let totalEquityUSDT = 0;
    let availableUSDT   = 0;

    const assets: WalletAsset[] = (data.data ?? [])
      .filter((a) => (parseFloat(a.available) || 0) + (parseFloat(a.frozen) || 0) > 0)
      .map((a) => {
        const free      = parseFloat(a.available)  || 0;
        const locked    = parseFloat(a.frozen)     || 0;
        const usdtValue = parseFloat(a.usdtValue)  || 0;
        return { coin: a.coinName, free, locked, usdtValue };
      });

    for (const a of assets) {
      totalEquityUSDT += a.usdtValue;
      if (a.coin === "USDT") availableUSDT = a.free;
    }

    assets.sort((a, b) => b.usdtValue - a.usdtValue || b.free - a.free);

    return {
      exchange: "bitget", status: "ok", keyConfigured: true,
      totalEquityUSDT, availableUSDT, assets, error: null, fetchedAt: Date.now(),
    };
  } catch (err) {
    return errWallet("bitget", err);
  }
}

// ── In-memory cache + background refresh loop ────────────────────────────────

const EXCHANGES = ["binance", "bybit", "kucoin", "bitget"] as const;
const REFRESH_INTERVAL_MS = 3_000;

// Seed cache with no_key placeholders so first read is never empty
const walletCache: Record<string, ExchangeWallet> = Object.fromEntries(
  EXCHANGES.map((ex) => [ex, noKey(ex)]),
);

let refreshLoopStarted = false;
let refreshInProgress  = false;  // guard against overlapping fetches

async function refreshAll(): Promise<void> {
  if (refreshInProgress) return;  // skip: previous round hasn't finished yet
  refreshInProgress = true;
  try {
    const results = await Promise.allSettled([
      fetchBinance(),
      fetchBybit(),
      fetchKucoin(),
      fetchBitget(),
    ]);

    results.forEach((r, i) => {
      const exchange = EXCHANGES[i]!;
      walletCache[exchange] = r.status === "fulfilled"
        ? r.value
        : errWallet(exchange, r.reason);
    });
  } finally {
    refreshInProgress = false;
  }
}

export function startWalletRefreshLoop(): void {
  if (refreshLoopStarted) return;
  refreshLoopStarted = true;

  // First fetch immediately, then repeat every REFRESH_INTERVAL_MS.
  // setInterval fires regardless of how long the previous call took —
  // the refreshInProgress guard prevents stacking concurrent requests.
  void refreshAll();
  setInterval(() => { void refreshAll(); }, REFRESH_INTERVAL_MS);

  logger.info({ intervalMs: REFRESH_INTERVAL_MS }, "wallet refresh loop started");
}

export function getCachedBalances(): ExchangeWallet[] {
  return EXCHANGES.map((ex) => walletCache[ex]!);
}

// ── Public API (kept for backwards-compat) ───────────────────────────────────

export async function fetchAllBalances(): Promise<ExchangeWallet[]> {
  await refreshAll();
  return getCachedBalances();
}
