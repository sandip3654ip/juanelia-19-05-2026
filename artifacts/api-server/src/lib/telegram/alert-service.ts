/**
 * Telegram alert service for spot arbitrage opportunities.
 *
 * Config (including auto-detected chat ID) is persisted to data/alert-config.json
 * so it survives server restarts.
 *
 * Chat ID can be auto-detected via detectAndSaveChatId() — no manual copy-paste needed.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger }           from "../logger.js";
import { spotScanner }      from "../spot-scanner/index.js";
import { spotPriceHistory } from "../spot-scanner/price-history.js";
import type { SpotOpportunity } from "../spot-scanner/types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AlertConfig {
  enabled:               boolean;
  minNetProfitPct:       number;
  minTimesHit:           number;
  cooldownMinutes:       number;
  maxPriceMovementPct:   number | null;
  priceMovementPeriodMs: number;
  /** Auto-detected or manually provided chat ID (overrides env var) */
  detectedChatId:        string | null;
  /** true if TELEGRAM_BOT_TOKEN env var is set */
  tokenConfigured:       boolean;
  /** true if both token + chatId (from any source) are ready */
  telegramConfigured:    boolean;
}

export interface AlertEvent {
  sentAt:        number;
  symbol:        string;
  buyExchange:   string;
  sellExchange:  string;
  netProfitPct:  number;
  message:       string;
}

// ── Persisted config ───────────────────────────────────────────────────────────

const DATA_DIR   = join(process.cwd(), "data");
const CONFIG_FILE = join(DATA_DIR, "alert-config.json");

type StoredConfig = {
  enabled:               boolean;
  minNetProfitPct:       number;
  minTimesHit:           number;
  cooldownMinutes:       number;
  maxPriceMovementPct:   number | null;
  priceMovementPeriodMs: number;
  detectedChatId:        string | null;
};

let config: StoredConfig = {
  enabled:               false,
  minNetProfitPct:       1.0,
  minTimesHit:           0,
  cooldownMinutes:       0.5,
  maxPriceMovementPct:   null,
  priceMovementPeriodMs: 4 * 3_600_000,
  detectedChatId:        null,
};

function loadConfigFromDisk(): void {
  try {
    const raw    = readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    config = { ...config, ...parsed };
    logger.info({ chatIdSet: !!config.detectedChatId }, "alert config loaded from disk");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err: (err as Error).message }, "alert config load failed — using defaults");
    }
  }
}

function saveConfigToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "alert config save failed");
  }
}

// ── Telegram credentials ────────────────────────────────────────────────────────

function botToken(): string | undefined { return process.env["TELEGRAM_BOT_TOKEN"]; }

/** Chat ID: auto-detected value takes priority over env var */
function chatId(): string | undefined {
  return config.detectedChatId ?? process.env["TELEGRAM_CHAT_ID"] ?? undefined;
}

function isTokenConfigured():    boolean { return !!botToken(); }
function isTelegramConfigured(): boolean { return !!(botToken() && chatId()); }

// ── Public API ─────────────────────────────────────────────────────────────────

export function getConfig(): AlertConfig {
  return {
    ...config,
    tokenConfigured:    isTokenConfigured(),
    telegramConfigured: isTelegramConfigured(),
  };
}

export function updateConfig(
  patch: Partial<StoredConfig>,
): AlertConfig {
  config = { ...config, ...patch };
  saveConfigToDisk();
  logger.info({ enabled: config.enabled }, "alert config updated");
  return getConfig();
}

export function getHistory(): AlertEvent[] {
  return [...alertHistory].reverse();
}

// ── Auto-detect chat ID ────────────────────────────────────────────────────────

export async function detectAndSaveChatId(): Promise<{
  ok:     boolean;
  chatId: string | null;
  error:  string | null;
}> {
  const token = botToken();
  if (!token) {
    return { ok: false, chatId: null, error: "TELEGRAM_BOT_TOKEN not set. Pehle Replit Secrets mein token add karo." };
  }

  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates?limit=10&offset=-10`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, chatId: null, error: `Telegram API error ${res.status}: ${body.slice(0, 120)}` };
    }

    const data = await res.json() as {
      ok:     boolean;
      result: Array<{
        message?:      { chat: { id: number } };
        channel_post?: { chat: { id: number } };
        my_chat_member?: { chat: { id: number } };
      }>;
    };

    if (!data.ok || !data.result.length) {
      return {
        ok:     false,
        chatId: null,
        error:  "Koi message nahi mila. Pehle apne bot ko koi bhi message bhejo, phir dobara try karo.",
      };
    }

    let detectedId: number | null = null;
    for (const update of data.result) {
      const chat =
        update.message?.chat ??
        update.channel_post?.chat ??
        update.my_chat_member?.chat;
      if (chat?.id) { detectedId = chat.id; break; }
    }

    if (!detectedId) {
      return {
        ok:     false,
        chatId: null,
        error:  "Message mila lekin chat ID extract nahi hua. Bot ko directly ek message bhejo.",
      };
    }

    config.detectedChatId = String(detectedId);
    saveConfigToDisk();
    logger.info({ chatId: detectedId }, "telegram chat ID auto-detected and saved");
    return { ok: true, chatId: String(detectedId), error: null };

  } catch (err) {
    return { ok: false, chatId: null, error: String(err) };
  }
}

// ── Telegram sender + auto-delete tracker ──────────────────────────────────────

const cooldownMap  = new Map<string, number>();
const alertHistory: AlertEvent[] = [];
const MAX_HISTORY        = 50;
const CHECK_INTERVAL_MS  = 30_000;
const CLEANUP_INTERVAL_MS = 30 * 60_000;  // run cleanup every 30 min
const MESSAGE_TTL_MS      = 24 * 60 * 60_000;  // delete messages older than 24 hours

interface PendingDelete { messageId: number; chatIdVal: string; sentAt: number }
const pendingDeletes: PendingDelete[] = [];

/** Send a message and record its ID for later auto-deletion. */
async function sendTelegram(text: string): Promise<void> {
  const token = botToken();
  const chat  = chatId();
  if (!token || !chat) throw new Error("Token or chat ID not configured");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { ok: boolean; result?: { message_id: number } };
  if (data.ok && data.result?.message_id) {
    pendingDeletes.push({ messageId: data.result.message_id, chatIdVal: chat, sentAt: Date.now() });
  }
}

/** Delete a single Telegram message silently (ignore 400 = already gone). */
async function deleteTelegramMessage(token: string, chatIdVal: string, messageId: number): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/deleteMessage`;
  await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatIdVal, message_id: messageId }),
  });
}

/** Cleanup loop: delete old messages and prune stale cooldown entries. */
async function runCleanup(): Promise<void> {
  const token = botToken();

  // Prune cooldownMap entries older than 2× the max possible cooldown (24h cap)
  const cooldownCutoff = Date.now() - Math.max(MESSAGE_TTL_MS, 2 * 60 * 60_000);
  for (const [key, ts] of cooldownMap) {
    if (ts < cooldownCutoff) cooldownMap.delete(key);
  }

  if (!token || pendingDeletes.length === 0) return;

  const now     = Date.now();
  const expired = pendingDeletes.filter(m => now - m.sentAt >= MESSAGE_TTL_MS);
  if (expired.length === 0) return;

  // Remove expired from queue first (even if delete fails)
  const expiredSet = new Set(expired.map(m => m.messageId));
  while (pendingDeletes.length > 0 && expiredSet.has(pendingDeletes[0].messageId)) {
    pendingDeletes.shift();
  }
  // Also remove any non-contiguous expired entries
  for (let i = pendingDeletes.length - 1; i >= 0; i--) {
    if (expiredSet.has(pendingDeletes[i].messageId)) pendingDeletes.splice(i, 1);
  }

  let deleted = 0;
  for (const m of expired) {
    try {
      await deleteTelegramMessage(token, m.chatIdVal, m.messageId);
      deleted++;
    } catch {
      // ignore — message may already be deleted
    }
  }

  if (deleted > 0) {
    logger.info({ deleted, pending: pendingDeletes.length }, "telegram: auto-deleted old alert messages");
  }
}

// ── Price movement helper ──────────────────────────────────────────────────────

function computePriceMovement(symbol: string, periodMs: number): number | null {
  const samples = spotPriceHistory.get(symbol);
  if (!samples || samples.length < 2) return null;
  const latest = samples[samples.length - 1];
  const cutoff = latest.ts - periodMs;
  let old: { ts: number; price: number } | null = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].ts <= cutoff) { old = samples[i]; break; }
  }
  if (!old) return null;
  return ((latest.price - old.price) / old.price) * 100;
}

function periodLabel(ms: number): string {
  const hours = ms / 3_600_000;
  return hours === Math.floor(hours) ? `${hours}H` : `${(ms / 60_000).toFixed(0)}m`;
}

// ── Message formatter ──────────────────────────────────────────────────────────

/** HTML-escape a string for safe insertion into Telegram HTML messages. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(v: number): string {
  if (v >= 1_000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1)     return v.toFixed(4);
  if (v >= 0.01)  return v.toFixed(6);
  return v.toExponential(2);
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatOpportunityMessage(opp: SpotOpportunity): string {
  const fees = opp.fees ?? {};
  const time = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

  const buyFeeEff  = (fees.buyFeeRate  ?? 0.001) * (1 + (fees.feeTaxRate ?? 0));
  const sellFeeEff = (fees.sellFeeRate ?? 0.001) * (1 + (fees.feeTaxRate ?? 0));

  const network  = esc(fees.withdrawNetwork ?? "?");
  const verified = fees.addressVerified === true ? " ✓" : fees.addressVerified === false ? " ~" : "";
  const speed    = fees.speedTier === "fast" ? "⚡ Fast" : fees.speedTier === "medium" ? "🕐 Medium" : "";
  const routes   = fees.routesConsidered != null && fees.routesConsidered > 1 ? `${fees.routesConsidered} routes` : "";
  const feeUSD   = fees.withdrawFeeUSD != null ? `~$${fees.withdrawFeeUSD.toFixed(3)}` : "";
  const feeCoin  = fees.totalTransferFeeInCoin != null
    ? ` (${fees.totalTransferFeeInCoin > 0.0001 ? fees.totalTransferFeeInCoin.toFixed(6) : fees.totalTransferFeeInCoin.toExponential(2)} ${esc(opp.symbol)})` : "";
  const transferParts = [speed, feeUSD + feeCoin, routes].filter(Boolean).join("  |  ");

  const periodMs = config.priceMovementPeriodMs;
  const movement = computePriceMovement(opp.symbol, periodMs);
  const movLine  = movement != null
    ? `📊 Price Movement (${periodLabel(periodMs)}): <b>${fmtPct(movement)}</b>`
    : `📊 Price Movement (${periodLabel(periodMs)}): not enough history`;

  const sorted = [...(opp.allPrices ?? [])].sort((a, b) => b.bid - a.bid);
  const pricesBlock = sorted.length > 0
    ? "💹 All Prices:\n" + sorted.map(p =>
        `  ${esc(cap(p.exchange)).padEnd(8)}  bid $${fmt(p.bid)}  /  ask $${fmt(p.ask)}`
      ).join("\n")
    : "";

  const timesHit      = opp.profitTimesHit     ?? 0;
  const highestProfit = opp.highestNetProfitPct ?? null;

  const lines = [
    `🚀 <b>${esc(opp.symbol)}/USDT — Spot Arb Alert</b>`,
    "",
    `💰 Net Profit: <b>${fmtPct(opp.netProfitPct)}</b>`,
    `📐 Spread: ${fmtPct(opp.priceDiffPct)}`,
    `⏱ Times Hit (4H): <b>${timesHit}×</b>`,
    `📈 Highest (4H): <b>${fmtPct(highestProfit)}</b>`,
    "",
    `📈 <b>BUY</b>  ${esc(cap(opp.buyExchange)).padEnd(8)}  $${fmt(opp.buyAsk)}  (fee: ${(buyFeeEff * 100).toFixed(2)}%)`,
    `📉 <b>SELL</b> ${esc(cap(opp.sellExchange)).padEnd(8)}  $${fmt(opp.sellBid)}  (fee: ${(sellFeeEff * 100).toFixed(2)}%)`,
    "",
    `🔀 via <b>${network}</b>${verified}  |  ${transferParts}`,
    "",
    movLine,
    ...(pricesBlock ? ["", pricesBlock] : []),
    "",
    `⏱ ${esc(time)} IST`,
  ];

  return lines.join("\n");
}

// ── Alert check loop ───────────────────────────────────────────────────────────

async function checkAndAlert(): Promise<void> {
  if (!config.enabled)        return;
  if (!isTelegramConfigured()) return;

  const opps       = spotScanner.getOpportunitiesWithTarget(config.minNetProfitPct);
  const now        = Date.now();
  const cooldownMs = config.cooldownMinutes * 60_000;
  const sentThisCycle = new Set<string>();

  for (const opp of opps) {
    if (sentThisCycle.has(opp.symbol)) continue;
    if (opp.netProfitPct < config.minNetProfitPct) continue;
    if (config.minTimesHit > 0 && (opp.profitTimesHit ?? 0) < config.minTimesHit) continue;

    if (config.maxPriceMovementPct !== null) {
      const movement = computePriceMovement(opp.symbol, config.priceMovementPeriodMs);
      if (movement !== null && Math.abs(movement) > config.maxPriceMovementPct) continue;
    }

    const key      = `${opp.symbol}:${opp.buyExchange}→${opp.sellExchange}`;
    const lastSent = cooldownMap.get(key) ?? 0;
    if (now - lastSent < cooldownMs) continue;

    const message = formatOpportunityMessage(opp);
    try {
      await sendTelegram(message);
      cooldownMap.set(key, now);
      sentThisCycle.add(opp.symbol);

      alertHistory.push({ sentAt: now, symbol: opp.symbol, buyExchange: opp.buyExchange, sellExchange: opp.sellExchange, netProfitPct: opp.netProfitPct, message });
      if (alertHistory.length > MAX_HISTORY) alertHistory.shift();

      logger.info({ symbol: opp.symbol, netProfitPct: opp.netProfitPct }, "telegram alert sent");
    } catch (err) {
      logger.warn({ err: String(err), symbol: opp.symbol }, "telegram alert failed");
    }
  }
}

// ── Test alert ─────────────────────────────────────────────────────────────────

export async function sendTestAlert(): Promise<{ ok: boolean; error: string | null }> {
  try {
    const time = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    const movLine = config.maxPriceMovementPct !== null
      ? `\n🚫 Max Price Movement: ${config.maxPriceMovementPct}% (${periodLabel(config.priceMovementPeriodMs)} window)`
      : "\n📊 Price Movement Filter: disabled";
    await sendTelegram(
      `🔔 <b>Test Alert — Arbitrage Monitor</b>\n\n` +
      `✅ Telegram alerts are working!\n` +
      `💰 Min Net Profit: ${config.minNetProfitPct}%` +
      (config.minTimesHit > 0 ? `\n⏱ Min Times Hit (4H): ${config.minTimesHit}×` : "") +
      movLine +
      `\n⏱ ${time} IST`,
    );
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Startup ────────────────────────────────────────────────────────────────────

let loopStarted = false;

export function startAlertLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  loadConfigFromDisk();
  setInterval(() => { void checkAndAlert(); }, CHECK_INTERVAL_MS);
  setInterval(() => { void runCleanup(); }, CLEANUP_INTERVAL_MS);
  logger.info(
    { intervalMs: CHECK_INTERVAL_MS, cleanupIntervalMs: CLEANUP_INTERVAL_MS, messageTtlMs: MESSAGE_TTL_MS, telegramConfigured: isTelegramConfigured() },
    "telegram alert loop started",
  );
}
