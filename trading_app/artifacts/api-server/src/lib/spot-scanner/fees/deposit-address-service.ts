/**
 * Deposit Address Service
 * ────────────────────────
 * Fetches ACTUAL wallet deposit addresses from ALL exchanges for ALL coins
 * across ALL deposit-enabled networks. Persists to disk, refreshes every hour
 * on the hour (IST): 12:00, 1:00, 2:00, … Manual refresh available at any time.
 *
 * Supported:
 *   Bybit   — GET /v5/asset/deposit/query-address  (HMAC signed)
 *             One call per coin (no chainType) → returns all chains at once.
 *             ~680 coins × 1 call = ~680 calls, throttled at 120ms = ~82s total.
 *
 *   Binance — GET /sapi/v1/capital/deposit/address  (HMAC signed)
 *             One call per coin+network (API requires both).
 *             Weight 10/call, limit 1200/min → 500ms throttle.
 *             ~400 coins × avg 3 networks = ~1200 calls = ~10 min total.
 *
 *   KuCoin  — GET /api/v2/deposit-addresses  (KC-API v2 HMAC signed)
 *             One call per coin → returns all chains at once.
 *             20 req/10s limit → 500ms throttle.
 *             ~800 coins × 1 call = ~800 calls = ~7 min total.
 *
 *   Bitget  — GET /api/v2/asset/deposit/address  (ACCESS-KEY v2 HMAC signed)
 *             One call per coin → returns all chains at once.
 *             10 req/s limit → 120ms throttle.
 *             ~600 coins × 1 call = ~600 calls = ~72s total.
 *
 * Key format: "EXCHANGE:COIN:CANONICAL_NETWORK"  e.g. "bybit:ETH:ARBITRUM"
 * Saved to: data/deposit-addresses.json
 */

import crypto from "crypto";
import fs     from "fs";
import path   from "path";
import { logger }           from "../../logger.js";
import { getAllBybitData }   from "./bybit-data.js";
import { getAllBinanceData } from "./binance-data.js";
import { getAllKucoinData }  from "./kucoin-data.js";
import { getAllBitgetData }  from "./bitget-data.js";
import { normalizeNetwork }  from "./withdrawal-fees.js";

// ── Credentials ───────────────────────────────────────────────────────────────

const BYBIT_API_KEY      = process.env.BYBIT_API_KEY      ?? "";
const BYBIT_API_SECRET   = process.env.BYBIT_API_SECRET   ?? "";
const BYBIT_RECV_WINDOW  = "20000";

const BINANCE_API_KEY    = process.env.BINANCE_API_KEY    ?? "";
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET ?? "";

const KUCOIN_API_KEY        = process.env.KUCOIN_API_KEY        ?? "";
const KUCOIN_API_SECRET     = process.env.KUCOIN_API_SECRET     ?? "";
const KUCOIN_API_PASSPHRASE = process.env.KUCOIN_API_PASSPHRASE ?? "";

const BITGET_API_KEY        = process.env.BITGET_API_KEY        ?? "";
const BITGET_API_SECRET     = process.env.BITGET_API_SECRET     ?? "";
const BITGET_API_PASSPHRASE = process.env.BITGET_API_PASSPHRASE ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DepositAddressEntry {
  exchange:  string;
  coin:      string;
  /** Canonical network name, e.g. "ARBITRUM", "BEP20", "SOL" */
  network:   string;
  /** Exchange-native chain ID, e.g. "ARBI" (Bybit) or "ARBITRUM" (Binance) */
  chainId:   string;
  /** Actual blockchain deposit address */
  address:   string;
  /** Memo / destination tag (XRP, XLM, ATOM etc.) — null if not required */
  tag:       string | null;
  fetchedAt: string;
  /**
   * Number of consecutive daily refreshes that returned the EXACT same address.
   * Starts at 1 on first fetch; increments each time address matches; resets to 1
   * if the address ever changes. A count ≥ 10 means the address is stable enough
   * to be considered safe for automated bot withdrawals.
   */
  confirmedCount: number;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const DATA_DIR   = path.join(process.cwd(), "data");
const DATA_FILE  = path.join(DATA_DIR, "deposit-addresses.json");
const MAX_AGE_MS   = 24 * 60 * 60 * 1000;   // skip fetch if disk data < 24h old

/** In-memory store: "EXCHANGE:COIN:NETWORK" → DepositAddressEntry */
let addressStore: Record<string, DepositAddressEntry> = {};
let lastFetchedAt: Date | null = null;
let isRefreshing = false;
let nextAutoRefreshAt: Date | null = null;

// ── Address-store helper ──────────────────────────────────────────────────────

/**
 * Fire-and-forget Telegram alert when a deposit address changes.
 * Uses env vars directly — no circular import from alert-service.
 */
function notifyAddressChanged(
  exchange: string, coin: string, network: string,
  oldAddress: string, newAddress: string,
): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chat  = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chat) return;

  const text =
    `⚠️ <b>Deposit Address Changed!</b>\n\n` +
    `Exchange : <b>${exchange.toUpperCase()}</b>\n` +
    `Coin     : <b>${coin}</b>\n` +
    `Network  : <b>${network}</b>\n\n` +
    `Old: <code>${oldAddress}</code>\n` +
    `New: <code>${newAddress}</code>\n\n` +
    `⚠️ confirmedCount reset to 1 — bot will not trade this pair until address is confirmed 10 times again.`;

  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
  }).catch((err: unknown) =>
    logger.warn({ err: String(err), exchange, coin, network }, "address-change telegram alert failed"),
  );
}

/**
 * Store or update a deposit address entry.
 * If the same address already exists for this key, increments confirmedCount.
 * If the address changed, resets confirmedCount to 1 and fires a Telegram alert.
 * Old disk data that lacks confirmedCount defaults to 1.
 */
function storeAddressEntry(
  key:     string,
  base:    Omit<DepositAddressEntry, "address" | "tag" | "fetchedAt" | "confirmedCount">,
  address: string,
  tag:     string | null,
): void {
  const existing     = addressStore[key];
  const prevCount    = existing?.confirmedCount ?? 1;
  const sameAddress  = existing?.address === address;
  const confirmedCount = sameAddress ? prevCount + 1 : 1;
  addressStore[key]  = { ...base, address, tag, fetchedAt: new Date().toISOString(), confirmedCount };

  // Alert only when a KNOWN address changes (not on first fetch)
  if (existing !== undefined && !sameAddress) {
    notifyAddressChanged(base.exchange, base.coin, base.network, existing.address, address);
    logger.warn(
      { exchange: base.exchange, coin: base.coin, network: base.network, oldAddress: existing.address, newAddress: address },
      "deposit address changed — confirmedCount reset, telegram alert sent",
    );
  }
}

/** How many consecutive refreshes have returned the same deposit address. 0 = not yet fetched. */
export function getAddressConfirmedCount(exchange: string, coin: string, network: string): number {
  return addressStore[`${exchange}:${coin}:${network}`]?.confirmedCount ?? 0;
}

/**
 * Returns true when the deposit address for this exchange+coin+network has been
 * fetched at least 10 consecutive times and returned the exact same address.
 * Used by the bot and card eligibility checks as a safety gate.
 */
export function isAddressConfirmed(exchange: string, coin: string, network: string): boolean {
  return getAddressConfirmedCount(exchange, coin, network) >= 10;
}

// ── Hourly scheduler — fires at :00 IST (12:00, 1:00, 2:00 …) ───────────────

const IST_OFFSET_MS = 5.5 * 60 * 60_000; // UTC+5:30

/** Ms until the next top-of-hour boundary in IST. */
function msUntilNextISTHour(): number {
  const nowIST  = Date.now() + IST_OFFSET_MS;
  const elapsed = nowIST % 3_600_000;
  return elapsed === 0 ? 3_600_000 : 3_600_000 - elapsed;
}

/** Returns the scheduled next auto-refresh time. */
export function getNextAutoRefreshAt(): Date | null {
  return nextAutoRefreshAt;
}

// ── Disk helpers ──────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw  = fs.readFileSync(DATA_FILE, "utf8");
    const json = JSON.parse(raw) as { fetchedAt: string | null; addresses: Record<string, DepositAddressEntry> };
    addressStore = json.addresses;
    // fetchedAt is null during incremental saves (refresh still in progress) — treat as stale
    if (json.fetchedAt) {
      lastFetchedAt = new Date(json.fetchedAt);
    }
    logger.info({ count: Object.keys(addressStore).length, fetchedAt: json.fetchedAt ?? "incomplete" }, "deposit addresses loaded from disk");
  } catch {
    // ignore — fresh start
  }
}

function saveToDisk(): void {
  // Fire-and-forget async write so we never block the event loop.
  const payload = JSON.stringify(
    { fetchedAt: lastFetchedAt?.toISOString() ?? null, addresses: addressStore },
    null,
    2,
  );
  fs.promises.mkdir(DATA_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(DATA_FILE, payload, "utf8"))
    .catch((err: unknown) => logger.warn({ err: String(err) }, "failed to save deposit addresses to disk"));
}

// ── Bybit HMAC signing ────────────────────────────────────────────────────────

function signBybit(queryString: string): Record<string, string> {
  const ts   = Date.now().toString();
  const msg  = ts + BYBIT_API_KEY + BYBIT_RECV_WINDOW + queryString;
  const sign = crypto.createHmac("sha256", BYBIT_API_SECRET).update(msg).digest("hex");
  return {
    "X-BAPI-API-KEY":     BYBIT_API_KEY,
    "X-BAPI-TIMESTAMP":   ts,
    "X-BAPI-SIGN":        sign,
    "X-BAPI-RECV-WINDOW": BYBIT_RECV_WINDOW,
  };
}

// ── Bybit deposit address API ─────────────────────────────────────────────────

interface BybitChainAddress {
  chainType:         string;   // Bybit chain id e.g. "ETH", "BSC", "ARBI"
  addressDeposit:    string;
  tagDeposit:        string;
  batchReleaseLimit: string;
  depositType:       string;
}

interface BybitDepositAddressResponse {
  retCode: number;
  retMsg:  string;
  result?: { coin: string; chains: BybitChainAddress[] };
}

// ── Retry helper ──────────────────────────────────────────────────────────────

/** null = real error (retry); "no_address" = unsupported (don't retry); T = success */
type FetchResult<T> = T | "no_address" | null;

async function withRetry<T>(
  fn:          () => Promise<FetchResult<T>>,
  maxRetries = 2,
  baseDelayMs = 2000,
): Promise<FetchResult<T>> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await fn();
    if (result !== null) return result;   // success or no_address — stop retrying
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  return null;
}

// ── Bybit deposit address API ─────────────────────────────────────────────────

/**
 * Fetch ALL deposit chains for a coin in one call.
 * Returns:
 *   - array of {chainId, address, tag}   → success
 *   - "no_address"                        → Bybit returned 0 chains (coin not supported / no address available)
 *   - null                                → real error (HTTP error, timeout, API error code) → will retry
 */
async function fetchBybitAllChains(
  coin: string,
): Promise<FetchResult<Array<{ chainId: string; address: string; tag: string | null }>>> {
  const qs = `coin=${coin}`;
  try {
    const res = await fetch(
      `https://api.bybit.com/v5/asset/deposit/query-address?${qs}`,
      { headers: { ...signBybit(qs), "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;   // HTTP error (4xx/5xx) → retry

    const body = (await res.json()) as BybitDepositAddressResponse;
    if (body.retCode !== 0) return null;                      // API-level error → retry
    if (!body.result?.chains?.length) return "no_address";   // Empty chains → coin not supported

    const rows = body.result.chains
      .filter(c => c.addressDeposit)
      .map(c => ({ chainId: c.chainType, address: c.addressDeposit, tag: c.tagDeposit || null }));
    return rows.length ? rows : "no_address";
  } catch {
    return null;   // network error / timeout → retry
  }
}

// ── KuCoin HMAC signing (v2) ──────────────────────────────────────────────────

function signKucoin(path: string, method: string, body = ""): Record<string, string> {
  const ts  = Date.now().toString();
  const str = ts + method.toUpperCase() + path + body;
  const sign       = crypto.createHmac("sha256", KUCOIN_API_SECRET).update(str).digest("base64");
  const passphrase = crypto.createHmac("sha256", KUCOIN_API_SECRET).update(KUCOIN_API_PASSPHRASE).digest("base64");
  return {
    "KC-API-KEY":         KUCOIN_API_KEY,
    "KC-API-SIGN":        sign,
    "KC-API-TIMESTAMP":   ts,
    "KC-API-PASSPHRASE":  passphrase,
    "KC-API-KEY-VERSION": "2",
    "Content-Type":       "application/json",
    "User-Agent":         "Mozilla/5.0",
  };
}

// ── KuCoin deposit address API ────────────────────────────────────────────────

interface KucoinDepositAddressItem {
  currency:        string;
  address:         string;
  memo:            string;
  chain:           string;   // human-readable e.g. "ERC20"
  chainId:         string;   // slug e.g. "eth", "bsc", "sol"
  contractAddress: string;
}

interface KucoinDepositAddressResponse {
  code: string;
  data: KucoinDepositAddressItem[];
}

interface KucoinCreateAddressResponse {
  code: string;
  data: {
    currency:    string;
    address:     string;
    memo:        string;
    chain:       string;
    chainId:     string;
  } | null;
}

/** GET /api/v2/deposit-addresses — returns already-generated addresses for a coin (all chains). */
async function fetchKucoinAllChains(
  coin: string,
): Promise<FetchResult<KucoinDepositAddressItem[]>> {
  const apiPath = `/api/v2/deposit-addresses?currency=${coin}`;
  try {
    const res = await fetch(
      `https://api.kucoin.com${apiPath}`,
      { headers: signKucoin(apiPath, "GET"), signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as KucoinDepositAddressResponse;
    if (body.code !== "200000") return null;
    if (!Array.isArray(body.data)) return "no_address";
    return body.data.filter(d => d.address);
  } catch {
    return null;
  }
}

/**
 * POST /api/v1/deposit-addresses — creates (or retrieves) a deposit address for a coin+chain.
 * KuCoin generates an address on first call; subsequent calls return the existing one.
 * Returns null if the coin/chain is not supported for deposits.
 */
async function createKucoinAddress(
  coin:    string,
  chainId: string,
): Promise<FetchResult<{ address: string; memo: string | null; chain: string; chainId: string }>> {
  const apiPath = "/api/v1/deposit-addresses";
  const bodyStr = JSON.stringify({ currency: coin, chain: chainId });
  try {
    const res = await fetch(
      `https://api.kucoin.com${apiPath}`,
      {
        method:  "POST",
        headers: signKucoin(apiPath, "POST", bodyStr),
        body:    bodyStr,
        signal:  AbortSignal.timeout(12_000),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as KucoinCreateAddressResponse;
    // KuCoin success
    if (body.code === "200000" && body.data?.address) {
      return { address: body.data.address, memo: body.data.memo || null, chain: body.data.chain, chainId: body.data.chainId };
    }
    // Known "not supported" codes → no_address (don't retry)
    // 900014 = currency/chain unsupported, 200004 = account not exist, etc.
    return "no_address";
  } catch {
    return null;
  }
}

// ── Bitget HMAC signing ───────────────────────────────────────────────────────

function signBitget(
  method:    string,
  path:      string,
  queryStr?: string,
): Record<string, string> {
  const ts      = Date.now().toString();
  const fullPath = queryStr ? `${path}?${queryStr}` : path;
  const preSign = ts + method.toUpperCase() + fullPath;
  const sign    = crypto.createHmac("sha256", BITGET_API_SECRET).update(preSign).digest("base64");
  return {
    "ACCESS-KEY":        BITGET_API_KEY,
    "ACCESS-SIGN":       sign,
    "ACCESS-TIMESTAMP":  ts,
    "ACCESS-PASSPHRASE": BITGET_API_PASSPHRASE,
    "Content-Type":      "application/json",
    "User-Agent":        "Mozilla/5.0",
  };
}

// ── Bitget deposit address API ────────────────────────────────────────────────

// Correct endpoint: GET /api/v2/spot/wallet/deposit-address?coin=BTC&chain=BTC
// Returns one address per coin+chain call; data is a single object (not array).
interface BitgetDepositAddressItem {
  address: string;
  chain:   string;
  coin:    string;
  tag:     string | null;
}

interface BitgetDepositAddressResponse {
  code: string;
  data: BitgetDepositAddressItem;
}

async function fetchBitgetAddress(
  coin:  string,
  chain: string,
): Promise<FetchResult<BitgetDepositAddressItem>> {
  const path  = "/api/v2/spot/wallet/deposit-address";
  const query = `coin=${coin}&chain=${chain}`;
  try {
    const res = await fetch(
      `https://api.bitget.com${path}?${query}`,
      { headers: signBitget("GET", path, query), signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;   // HTTP error → retry
    const body = (await res.json()) as BitgetDepositAddressResponse;
    if (body.code !== "00000") return "no_address";   // API-level error → coin/chain not supported
    if (!body.data?.address) return "no_address";
    return body.data;
  } catch {
    return null;   // network / timeout → retry
  }
}

// ── Bitget full refresh ───────────────────────────────────────────────────────

async function refreshBitgetFull(): Promise<void> {
  const allCoins = Object.entries(getAllBitgetData());
  const depositCoins = allCoins.filter(([, cd]) => Object.values(cd).some(n => n.depositEnable));

  const p = exchangeProgress["bitget"];
  Object.assign(p, {
    running: true, total: depositCoins.length, done: 0, fetched: 0,
    generated: 0, skipped: 0, noAddress: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null,
  });

  logger.info({ coins: allCoins.length, depositCoins: depositCoins.length }, "bitget deposit addresses: starting full refresh");

  let saveCounter = 0;

  for (const [coin, coinData] of allCoins) {
    const depositChains = Object.values(coinData).filter(n => n.depositEnable);
    if (depositChains.length === 0) { p.skipped++; continue; }

    for (const chainEntry of depositChains) {
      const item = await withRetry(() => fetchBitgetAddress(coin, chainEntry.chain));
      if (item === null)           { p.failed++;    await new Promise(r => setTimeout(r, 120)); continue; }
      if (item === "no_address")   { p.noAddress++; await new Promise(r => setTimeout(r, 120)); continue; }

      const canonicalNet = normalizeNetwork(chainEntry.chain);
      if (!canonicalNet) continue;

      storeAddressEntry(
        `bitget:${coin}:${canonicalNet}`,
        { exchange: "bitget", coin, network: canonicalNet, chainId: chainEntry.chain },
        item.address, item.tag || null,
      );
      p.fetched++;
      await new Promise(r => setTimeout(r, 120));
    }

    p.done++;
    if (++saveCounter % 100 === 0) {
      saveToDisk();
      logger.info({ done: p.done, total: p.total, fetched: p.fetched, noAddress: p.noAddress }, "bitget deposit addresses: progress save");
    }
  }

  p.running = false;
  p.finishedAt = new Date().toISOString();
  logger.info({ fetched: p.fetched, noAddress: p.noAddress, skipped: p.skipped, failed: p.failed, total: allCoins.length }, "bitget deposit addresses: full refresh done");
}

// ── Binance HMAC signing ──────────────────────────────────────────────────────

function signBinance(queryString: string): string {
  return crypto.createHmac("sha256", BINANCE_API_SECRET).update(queryString).digest("hex");
}

// ── Binance deposit address API ───────────────────────────────────────────────

interface BinanceDepositAddressResponse {
  address: string;
  coin:    string;
  tag:     string;
  url:     string;
}

async function fetchBinanceAddress(
  coin:      string,
  networkId: string,
): Promise<FetchResult<{ address: string; tag: string | null }>> {
  const ts  = Date.now();
  const qs  = `coin=${coin}&network=${networkId}&timestamp=${ts}`;
  const sig = signBinance(qs);
  try {
    const res = await fetch(
      `https://api.binance.com/sapi/v1/capital/deposit/address?${qs}&signature=${sig}`,
      {
        headers: { "X-MBX-APIKEY": BINANCE_API_KEY, "User-Agent": "Mozilla/5.0" },
        signal:  AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      // Try to parse body to distinguish "not supported" from real errors
      try {
        const err = (await res.json()) as { code?: number };
        // Binance error codes for "coin/network not supported"
        if (err.code === -1085 || err.code === -1100 || res.status === 400) return "no_address";
      } catch { /* parse failed */ }
      // 5xx or unrecognized 4xx → real error, retry
      return res.status >= 500 ? null : "no_address";
    }
    const body = (await res.json()) as BinanceDepositAddressResponse;
    if (!body.address) return "no_address";
    return { address: body.address, tag: body.tag || null };
  } catch {
    return null;   // network / timeout → retry
  }
}

// ── Per-exchange refresh progress ─────────────────────────────────────────────

export interface ExchangeRefreshProgress {
  exchange:   string;
  running:    boolean;
  /** Number of deposit-enabled coins to process */
  total:      number;
  /** Coins processed so far */
  done:       number;
  /** Addresses retrieved via GET (already existed) */
  fetched:    number;
  /** Addresses created via POST (KuCoin only) */
  generated:  number;
  skipped:    number;
  /** Coin/chain not supported for deposits at this exchange — expected, not a real error */
  noAddress:  number;
  /** Real errors: network timeout, HTTP 5xx, unexpected API error */
  failed:     number;
  startedAt:  string | null;
  finishedAt: string | null;
}

function blankProgress(exchange: string): ExchangeRefreshProgress {
  return { exchange, running: false, total: 0, done: 0, fetched: 0, generated: 0, skipped: 0, noAddress: 0, failed: 0, startedAt: null, finishedAt: null };
}

const exchangeProgress: Record<string, ExchangeRefreshProgress> = {
  bybit:   blankProgress("bybit"),
  binance: blankProgress("binance"),
  kucoin:  blankProgress("kucoin"),
  bitget:  blankProgress("bitget"),
};

const VALID_ADDR_EXCHANGES = ["bybit", "binance", "kucoin", "bitget"] as const;
type AddrExchangeId = typeof VALID_ADDR_EXCHANGES[number];

export function getRefreshProgress(exchange: string): ExchangeRefreshProgress | null {
  if (!VALID_ADDR_EXCHANGES.includes(exchange as AddrExchangeId)) return null;
  return { ...exchangeProgress[exchange as AddrExchangeId] };
}

/** @deprecated Use getRefreshProgress("kucoin") */
export function getKucoinGenerationProgress(): ExchangeRefreshProgress {
  return { ...exchangeProgress["kucoin"] };
}

// ── KuCoin full refresh ───────────────────────────────────────────────────────

async function refreshKucoinFull(): Promise<void> {
  const allCoins = Object.entries(getAllKucoinData());

  // Count deposit-enabled coins for progress tracking
  const depositCoins = allCoins.filter(([, cd]) =>
    Object.values(cd).some(n => n.depositEnable),
  );

  const p = exchangeProgress["kucoin"];
  Object.assign(p, {
    running: true, total: depositCoins.length, done: 0, fetched: 0,
    generated: 0, skipped: 0, noAddress: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null,
  });

  logger.info({ coins: allCoins.length, depositCoins: depositCoins.length }, "kucoin deposit addresses: starting full refresh");

  let saveCounter = 0;

  for (const [coin, coinData] of allCoins) {
    const depositNetworks = Object.values(coinData).filter(n => n.depositEnable);
    if (depositNetworks.length === 0) { p.skipped++; continue; }

    // GET existing addresses (all chains at once) — retry once on failure
    const existing = await withRetry(() => fetchKucoinAllChains(coin), 1, 1000);
    await new Promise(r => setTimeout(r, 500));

    for (const netEntry of depositNetworks) {
      const canonicalNetwork = normalizeNetwork(netEntry.chainId);

      // Check if we already got it from v2 GET
      const existingList = Array.isArray(existing) ? existing : [];
      const fromGet = existingList.find(r => r.chainId === netEntry.chainId);
      if (fromGet) {
        storeAddressEntry(
          `kucoin:${coin}:${canonicalNetwork}`,
          { exchange: "kucoin", coin, network: canonicalNetwork, chainId: netEntry.chainId },
          fromGet.address, fromGet.memo || null,
        );
        p.fetched++;
        continue;
      }

      // POST to create address (with 1 retry on real errors)
      const created = await withRetry(() => createKucoinAddress(coin, netEntry.chainId), 1, 1500);
      await new Promise(r => setTimeout(r, 600));
      if (created === null)         { p.failed++;    continue; }
      if (created === "no_address") { p.noAddress++; continue; }

      storeAddressEntry(
        `kucoin:${coin}:${canonicalNetwork}`,
        { exchange: "kucoin", coin, network: canonicalNetwork, chainId: netEntry.chainId },
        created.address, created.memo || null,
      );
      p.generated++;
    }

    p.done++;
    if (++saveCounter % 50 === 0) {
      saveToDisk();
      logger.info({ done: p.done, total: p.total, fetched: p.fetched, generated: p.generated, noAddress: p.noAddress }, "kucoin deposit addresses: progress save");
    }
  }

  p.running = false;
  p.finishedAt = new Date().toISOString();
  logger.info({ fetched: p.fetched, generated: p.generated, noAddress: p.noAddress, skipped: p.skipped, failed: p.failed, total: allCoins.length }, "kucoin deposit addresses: full refresh done");
}

// ── Bybit full refresh ────────────────────────────────────────────────────────

async function refreshBybitFull(): Promise<void> {
  const allCoins = Object.entries(getAllBybitData());
  const depositCoins = allCoins.filter(([, cd]) => cd.deposit.some(d => d.depositEnable));

  const p = exchangeProgress["bybit"];
  Object.assign(p, {
    running: true, total: depositCoins.length, done: 0, fetched: 0,
    generated: 0, skipped: 0, noAddress: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null,
  });

  logger.info({ coins: allCoins.length, depositCoins: depositCoins.length }, "bybit deposit addresses: starting full refresh");

  let saveCounter = 0;

  for (const [coin, coinData] of allCoins) {
    const depositChains = coinData.deposit.filter(d => d.depositEnable);
    if (depositChains.length === 0) { p.skipped++; continue; }

    const results = await withRetry(() => fetchBybitAllChains(coin));
    if (results === null)         { p.failed++;    p.done++; await new Promise(r => setTimeout(r, 120)); continue; }
    if (results === "no_address") { p.noAddress++; p.done++; await new Promise(r => setTimeout(r, 120)); continue; }

    for (const chainEntry of depositChains) {
      const matched = results.find(r => r.chainId === chainEntry.chain);
      if (!matched) continue;

      const canonicalNetwork = normalizeNetwork(chainEntry.chain);
      storeAddressEntry(
        `bybit:${coin}:${canonicalNetwork}`,
        { exchange: "bybit", coin, network: canonicalNetwork, chainId: chainEntry.chain },
        matched.address, matched.tag,
      );
      p.fetched++;
    }

    p.done++;
    if (++saveCounter % 100 === 0) {
      saveToDisk();
      logger.info({ done: p.done, total: p.total, fetched: p.fetched, noAddress: p.noAddress }, "bybit deposit addresses: progress save");
    }

    await new Promise(r => setTimeout(r, 120));
  }

  p.running = false;
  p.finishedAt = new Date().toISOString();
  logger.info({ fetched: p.fetched, noAddress: p.noAddress, skipped: p.skipped, failed: p.failed, total: allCoins.length }, "bybit deposit addresses: full refresh done");
}

// ── Binance full refresh ──────────────────────────────────────────────────────

async function refreshBinanceFull(): Promise<void> {
  const allCoins = Object.entries(getAllBinanceData());
  const depositCoins = allCoins.filter(([, cd]) => Object.values(cd).some(n => n.depositEnable));

  const p = exchangeProgress["binance"];
  Object.assign(p, {
    running: true, total: depositCoins.length, done: 0, fetched: 0,
    generated: 0, skipped: 0, noAddress: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null,
  });

  logger.info({ coins: allCoins.length, depositCoins: depositCoins.length }, "binance deposit addresses: starting full refresh");

  let saveCounter = 0;

  for (const [coin, coinData] of allCoins) {
    const depositNetworks = Object.values(coinData).filter(n => n.depositEnable);
    if (depositNetworks.length === 0) { p.skipped++; continue; }

    for (const netEntry of depositNetworks) {
      const result = await withRetry(() => fetchBinanceAddress(coin, netEntry.network), 1, 3000);
      if (result === null)         { p.failed++;    }
      else if (result === "no_address") { p.noAddress++; }
      else {
        const canonicalNetwork = normalizeNetwork(netEntry.network);
        storeAddressEntry(
          `binance:${coin}:${canonicalNetwork}`,
          { exchange: "binance", coin, network: canonicalNetwork, chainId: netEntry.network },
          result.address, result.tag,
        );
        p.fetched++;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    p.done++;
    if (++saveCounter % 50 === 0) {
      saveToDisk();
      logger.info({ done: p.done, total: p.total, fetched: p.fetched, noAddress: p.noAddress }, "binance deposit addresses: progress save");
    }
  }

  p.running = false;
  p.finishedAt = new Date().toISOString();
  logger.info({ fetched: p.fetched, noAddress: p.noAddress, skipped: p.skipped, failed: p.failed, total: allCoins.length }, "binance deposit addresses: full refresh done");
}

// ── Single-exchange refresh (triggered from route) ────────────────────────────

const VALID_EXCHANGES = ["bybit", "binance", "kucoin", "bitget"] as const;
type ExchangeId = typeof VALID_EXCHANGES[number];

/** Trigger a single-exchange address refresh in the background. Idempotent: won't start if already running. */
export async function refreshExchangeAddresses(exchange: ExchangeId): Promise<{ started: boolean; reason?: string }> {
  const p = exchangeProgress[exchange];
  if (p.running) return { started: false, reason: "already_running" };

  const credMap: Record<ExchangeId, boolean> = {
    bybit:   Boolean(BYBIT_API_KEY && BYBIT_API_SECRET),
    binance: Boolean(BINANCE_API_KEY && BINANCE_API_SECRET),
    kucoin:  Boolean(KUCOIN_API_KEY && KUCOIN_API_SECRET && KUCOIN_API_PASSPHRASE),
    bitget:  Boolean(BITGET_API_KEY && BITGET_API_SECRET && BITGET_API_PASSPHRASE),
  };
  if (!credMap[exchange]) return { started: false, reason: "credentials_missing" };

  const refreshFn: Record<ExchangeId, () => Promise<void>> = {
    bybit:   refreshBybitFull,
    binance: refreshBinanceFull,
    kucoin:  refreshKucoinFull,
    bitget:  refreshBitgetFull,
  };

  // Fire and forget — caller polls progress endpoint
  void refreshFn[exchange]().then(() => {
    saveToDisk();
    logger.info({ exchange, total: Object.keys(addressStore).filter(k => k.startsWith(exchange + ":")).length }, "exchange addresses saved to disk");
  }).catch((err: unknown) => {
    logger.error({ exchange, err }, "exchange address refresh failed");
  });

  return { started: true };
}

/** @deprecated Use refreshExchangeAddresses("kucoin") */
export async function generateKucoinAddresses(): Promise<void> {
  await refreshExchangeAddresses("kucoin");
}

// ── Main refresh ──────────────────────────────────────────────────────────────

export async function refreshDepositAddresses(): Promise<void> {
  if (isRefreshing) {
    logger.warn("deposit address refresh already in progress — skipping");
    return;
  }
  isRefreshing = true;

  try {
    // Run all exchanges in parallel — each has its own rate limit and does not
    // interfere with others.  JS single-thread guarantees no addressStore corruption.
    // Total time = max(slowest exchange) instead of sum of all exchanges.
    const tasks: Promise<void>[] = [];

    if (BYBIT_API_KEY && BYBIT_API_SECRET) {
      tasks.push(
        refreshBybitFull().then(() => {
          saveToDisk();   // incremental save — fetchedAt still null (refresh ongoing)
          logger.info("bybit addresses saved to disk (incremental)");
        }),
      );
    } else {
      logger.warn("bybit deposit addresses: skipped — BYBIT_API_KEY/SECRET not set");
    }

    if (BINANCE_API_KEY && BINANCE_API_SECRET) {
      tasks.push(
        refreshBinanceFull().then(() => {
          saveToDisk();
          logger.info("binance addresses saved to disk (incremental)");
        }),
      );
    } else {
      logger.warn("binance deposit addresses: skipped — BINANCE_API_KEY/SECRET not set");
    }

    if (KUCOIN_API_KEY && KUCOIN_API_SECRET && KUCOIN_API_PASSPHRASE) {
      tasks.push(
        refreshKucoinFull().then(() => {
          saveToDisk();
          logger.info("kucoin addresses saved to disk (incremental)");
        }),
      );
    } else {
      logger.warn("kucoin deposit addresses: skipped — KUCOIN_API_KEY/SECRET/PASSPHRASE not set");
    }

    if (BITGET_API_KEY && BITGET_API_SECRET && BITGET_API_PASSPHRASE) {
      tasks.push(
        refreshBitgetFull().then(() => {
          saveToDisk();
          logger.info("bitget addresses saved to disk (incremental)");
        }),
      );
    } else {
      logger.warn("bitget deposit addresses: skipped — BITGET_API_KEY/SECRET/PASSPHRASE not set");
    }

    logger.info({ exchanges: tasks.length }, "deposit address refresh: all exchanges running in parallel");
    await Promise.all(tasks);
  } finally {
    isRefreshing = false;
    lastFetchedAt = new Date();
    saveToDisk();   // final save with fetchedAt timestamp set
    logger.info({ total: Object.keys(addressStore).length }, "deposit address refresh: all exchanges done, final save complete");
  }
}

// ── Public accessors ──────────────────────────────────────────────────────────

/** Get deposit address for a specific exchange + coin + canonical network. */
export function getDepositAddress(
  exchange: string,
  coin:     string,
  network:  string,
): DepositAddressEntry | null {
  return addressStore[`${exchange}:${coin}:${network}`] ?? null;
}

/** Get all saved deposit addresses. */
export function getAllDepositAddresses(): Record<string, DepositAddressEntry> {
  return addressStore;
}

/**
 * Reset all confirmedCounts to 1 without deleting addresses.
 * Call this on data reset so that the verified (≥10) badge clears.
 * The bot will not trade any pair until 10 consecutive same-address
 * fetches are completed again.
 */
export function resetAllConfirmedCounts(): number {
  const keys = Object.keys(addressStore);
  for (const key of keys) {
    const entry = addressStore[key];
    if (entry) {
      addressStore[key] = { ...entry, confirmedCount: 1 };
    }
  }
  saveToDisk();
  logger.info({ count: keys.length }, "deposit address confirmedCounts reset to 1");
  return keys.length;
}

/** Metadata about the current state. */
export function getDepositAddressStatus(): {
  count:         number;
  bybitCount:    number;
  binanceCount:  number;
  kucoinCount:   number;
  bitgetCount:   number;
  fetchedAt:     Date | null;
  bybitReady:    boolean;
  binanceReady:  boolean;
  kucoinReady:   boolean;
  bitgetReady:   boolean;
  isRefreshing:  boolean;
} {
  const keys         = Object.keys(addressStore);
  const bybitCount   = keys.filter(k => k.startsWith("bybit:")).length;
  const binanceCount = keys.filter(k => k.startsWith("binance:")).length;
  const kucoinCount  = keys.filter(k => k.startsWith("kucoin:")).length;
  const bitgetCount  = keys.filter(k => k.startsWith("bitget:")).length;
  return {
    count:        keys.length,
    bybitCount,
    binanceCount,
    kucoinCount,
    bitgetCount,
    fetchedAt:    lastFetchedAt,
    bybitReady:   !!(BYBIT_API_KEY   && BYBIT_API_SECRET),
    binanceReady: !!(BINANCE_API_KEY && BINANCE_API_SECRET),
    kucoinReady:  !!(KUCOIN_API_KEY  && KUCOIN_API_SECRET && KUCOIN_API_PASSPHRASE),
    bitgetReady:  !!(BITGET_API_KEY  && BITGET_API_SECRET && BITGET_API_PASSPHRASE),
    isRefreshing,
  };
}

// ── Service start ─────────────────────────────────────────────────────────────

/** Start the deposit address service — fetches ALL coins across ALL networks. */
export function startDepositAddressService(): void {
  loadFromDisk();

  const ageMs   = lastFetchedAt ? Date.now() - lastFetchedAt.getTime() : Infinity;
  const isFresh = ageMs < MAX_AGE_MS;

  if (!isFresh) {
    // No data or data is stale — fetch after warmup delay
    logger.info("deposit addresses: stale or missing — scheduling fetch in 90s");
    setTimeout(() => void refreshDepositAddresses(), 90_000);
  } else {
    logger.info(
      { cachedAddresses: Object.keys(addressStore).length },
      "deposit addresses: disk data is fresh — skipping immediate fetch",
    );
  }

  // Schedule on-the-hour (IST) auto-refresh — fires at 12:00, 1:00, 2:00, …
  function scheduleNextHourlyRefresh(): void {
    const waitMs = msUntilNextISTHour();
    nextAutoRefreshAt = new Date(Date.now() + waitMs);
    logger.info(
      { nextAutoRefreshAt: nextAutoRefreshAt.toISOString(), waitMs },
      "deposit addresses: next auto-refresh scheduled at top of IST hour",
    );
    setTimeout(() => {
      void refreshDepositAddresses();
      scheduleNextHourlyRefresh();
    }, waitMs);
  }
  scheduleNextHourlyRefresh();
}
