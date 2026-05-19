/**
 * Withdrawal service — places crypto withdrawals on Binance, Bybit, KuCoin, Bitget.
 * Also polls withdrawal status so the bot can track when funds leave the exchange.
 */

import crypto from "crypto";
import { logger } from "../logger.js";

export type Exchange = "binance" | "bybit" | "kucoin" | "bitget";

export interface WithdrawInput {
  coin:      string;
  /** Exchange-native chain ID (e.g. "BNB" for Binance BEP20, "eth" for KuCoin ERC20) */
  chainId:   string;
  address:   string;
  tag?:      string | null;
  amount:    number;
  clientId?: string;
}

export interface WithdrawResult {
  withdrawalId: string;
  raw?:         unknown;
}

export type WithdrawStatusCode = "pending" | "processing" | "success" | "failed" | "canceled";

export interface WithdrawStatus {
  id:     string;
  status: WithdrawStatusCode;
  txId?:  string;
  raw?:   unknown;
}

// ── Binance ───────────────────────────────────────────────────────────────────

function binanceSign(qs: string): string {
  return crypto.createHmac("sha256", process.env.BINANCE_API_SECRET ?? "").update(qs).digest("hex");
}
function binanceHeaders(): Record<string, string> {
  return { "X-MBX-APIKEY": process.env.BINANCE_API_KEY ?? "" };
}

async function binanceWithdraw(input: WithdrawInput): Promise<WithdrawResult> {
  if (!process.env.BINANCE_API_KEY) throw new Error("Binance API keys not configured");
  const p: Record<string, string | number> = {
    coin: input.coin, network: input.chainId,
    address: input.address, amount: input.amount,
    timestamp: Date.now(), recvWindow: 5_000,
  };
  if (input.tag)      p["addressTag"]      = input.tag;
  if (input.clientId) p["withdrawOrderId"] = input.clientId;
  const qs  = new URLSearchParams(p as Record<string, string>).toString();
  const sig = binanceSign(qs);
  const res = await fetch(`https://api.binance.com/sapi/v1/capital/withdraw/apply?${qs}&signature=${sig}`, {
    method: "POST", headers: binanceHeaders(), signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`Binance withdraw: ${body["code"] ?? res.status}: ${body["msg"] ?? ""}`);
  logger.info({ exchange: "binance", coin: input.coin, chainId: input.chainId, withdrawalId: body["id"] }, "withdrawal submitted");
  return { withdrawalId: String(body["id"]), raw: body };
}

async function binanceWithdrawStatus(coin: string, id: string): Promise<WithdrawStatus | null> {
  if (!process.env.BINANCE_API_KEY) return null;
  const ts  = Date.now();
  const qs  = `coin=${coin}&limit=50&timestamp=${ts}&recvWindow=5000`;
  const sig = binanceSign(qs);
  const res = await fetch(`https://api.binance.com/sapi/v1/capital/withdraw/history?${qs}&signature=${sig}`, {
    headers: binanceHeaders(), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const list = await res.json() as Array<{ id: string; status: number; txId?: string }>;
  const e    = list.find(r => r.id === id);
  if (!e) return null;
  // Binance: 0=Email Sent, 1=Cancelled, 2=Awaiting Approval, 3=Rejected, 4=Processing, 5=Failure, 6=Completed
  const MAP: Record<number, WithdrawStatusCode> = { 0:"pending", 1:"canceled", 2:"pending", 3:"failed", 4:"processing", 5:"failed", 6:"success" };
  return { id, status: MAP[e.status] ?? "pending", txId: e.txId, raw: e };
}

// ── Bybit ─────────────────────────────────────────────────────────────────────

function bybitAuthHeaders(body: string): Record<string, string> {
  const apiKey = process.env.BYBIT_API_KEY ?? "";
  const secret = process.env.BYBIT_API_SECRET ?? "";
  const ts     = Date.now().toString();
  const recv   = "10000";
  const sig    = crypto.createHmac("sha256", secret).update(ts + apiKey + recv + body).digest("hex");
  return { "X-BAPI-API-KEY": apiKey, "X-BAPI-SIGN": sig, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv, "Content-Type": "application/json" };
}

function bybitQsHeaders(qs: string): Record<string, string> {
  const apiKey = process.env.BYBIT_API_KEY ?? "";
  const secret = process.env.BYBIT_API_SECRET ?? "";
  const ts     = Date.now().toString();
  const recv   = "10000";
  const sig    = crypto.createHmac("sha256", secret).update(ts + apiKey + recv + qs).digest("hex");
  return { "X-BAPI-API-KEY": apiKey, "X-BAPI-SIGN": sig, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv };
}

async function bybitWithdraw(input: WithdrawInput): Promise<WithdrawResult> {
  if (!process.env.BYBIT_API_KEY) throw new Error("Bybit API keys not configured");
  const payload: Record<string, unknown> = {
    coin: input.coin, chain: input.chainId,
    address: input.address, amount: String(input.amount),
    // UNIFIED = Bybit Unified Trading Account where spot-traded coins reside.
    // FUND is for the separate funding/custodial account — coins would not be there after a spot trade.
    accountType: "UNIFIED",
  };
  if (input.tag) payload["tag"] = input.tag;
  const bodyStr = JSON.stringify(payload);
  const res = await fetch("https://api.bybit.com/v5/asset/withdraw/create", {
    method: "POST", headers: bybitAuthHeaders(bodyStr), body: bodyStr, signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json() as { retCode: number; retMsg: string; result?: { id: string } };
  if (body.retCode !== 0) throw new Error(`Bybit withdraw: ${body.retCode}: ${body.retMsg}`);
  logger.info({ exchange: "bybit", coin: input.coin, chainId: input.chainId, withdrawalId: body.result?.id }, "withdrawal submitted");
  return { withdrawalId: body.result!.id, raw: body };
}

async function bybitWithdrawStatus(id: string): Promise<WithdrawStatus | null> {
  if (!process.env.BYBIT_API_KEY) return null;
  const qs  = `withdrawID=${id}`;
  const res = await fetch(`https://api.bybit.com/v5/asset/withdraw/query-record?${qs}`, {
    headers: bybitQsHeaders(qs), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = await res.json() as { retCode: number; result?: { rows: Array<{ withdrawId: string; status: string; txID?: string }> } };
  if (body.retCode !== 0) return null;
  const e = body.result?.rows.find(r => r.withdrawId === id);
  if (!e) return null;
  const MAP: Record<string, WithdrawStatusCode> = {
    SecurityCheck: "pending", Pending: "pending", success: "success",
    BlockchainConfirmed: "success", CancelByUser: "canceled", Reject: "failed", Fail: "failed",
    approving: "pending", processing: "processing",
  };
  return { id, status: MAP[e.status] ?? "pending", txId: e.txID, raw: e };
}

// ── KuCoin ────────────────────────────────────────────────────────────────────

function kucoinHeaders(method: string, path: string, body = ""): Record<string, string> {
  const apiKey  = process.env.KUCOIN_API_KEY    ?? "";
  const secret  = process.env.KUCOIN_API_SECRET ?? "";
  const phrase  = process.env.KUCOIN_API_PASSPHRASE ?? "";
  const ts      = Date.now().toString();
  const sign    = crypto.createHmac("sha256", secret).update(ts + method.toUpperCase() + path + body).digest("base64");
  const pp      = crypto.createHmac("sha256", secret).update(phrase).digest("base64");
  return { "KC-API-KEY": apiKey, "KC-API-SIGN": sign, "KC-API-TIMESTAMP": ts, "KC-API-PASSPHRASE": pp, "KC-API-KEY-VERSION": "2", "Content-Type": "application/json" };
}

async function kucoinWithdraw(input: WithdrawInput): Promise<WithdrawResult> {
  if (!process.env.KUCOIN_API_KEY) throw new Error("KuCoin API keys not configured");

  // ── Step 1: Move coins from TRADE → MAIN account ─────────────────────────
  // After a spot buy on KuCoin, coins land in the "trade" account.
  // KuCoin's withdrawal endpoint only works from the "main" account.
  // So we must do an internal transfer first.
  const xferPath    = "/api/v2/accounts/inner-transfer";
  const xferPayload = JSON.stringify({
    clientOid: `bot-xfer-${Date.now()}`,
    currency:  input.coin,
    from:      "trade",
    to:        "main",
    amount:    String(input.amount),
  });
  const xferRes  = await fetch(`https://api.kucoin.com${xferPath}`, {
    method: "POST", headers: kucoinHeaders("POST", xferPath, xferPayload), body: xferPayload, signal: AbortSignal.timeout(10_000),
  });
  const xferBody = await xferRes.json() as { code: string; msg?: string };
  if (xferBody.code !== "200000") {
    throw new Error(`KuCoin TRADE→MAIN transfer failed: ${xferBody.code}: ${xferBody.msg ?? ""}`);
  }
  logger.info({ exchange: "kucoin", coin: input.coin, amount: input.amount }, "kucoin: trade→main transfer done");

  // ── Step 2: Withdraw from MAIN account ───────────────────────────────────
  const path    = "/api/v1/withdrawals";
  const payload: Record<string, unknown> = {
    currency: input.coin, address: input.address,
    // KuCoin API requires amount as a string (not a JSON number).
    amount: String(input.amount), chain: input.chainId,
  };
  if (input.tag) payload["memo"] = input.tag;
  const bodyStr = JSON.stringify(payload);
  const res = await fetch(`https://api.kucoin.com${path}`, {
    method: "POST", headers: kucoinHeaders("POST", path, bodyStr), body: bodyStr, signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json() as { code: string; msg?: string; data?: { withdrawalId: string } };
  if (body.code !== "200000") throw new Error(`KuCoin withdraw: ${body.code}: ${body.msg ?? ""}`);
  logger.info({ exchange: "kucoin", coin: input.coin, chainId: input.chainId, withdrawalId: body.data?.withdrawalId }, "withdrawal submitted");
  return { withdrawalId: body.data!.withdrawalId, raw: body };
}

async function kucoinWithdrawStatus(coin: string, id: string): Promise<WithdrawStatus | null> {
  if (!process.env.KUCOIN_API_KEY) return null;
  const path = `/api/v1/withdrawals?currency=${coin}&pageSize=50`;
  const res  = await fetch(`https://api.kucoin.com${path}`, {
    headers: kucoinHeaders("GET", path), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = await res.json() as { code: string; data?: { items: Array<{ id: string; status: string; hash?: string }> } };
  if (body.code !== "200000") return null;
  const e = body.data?.items.find(r => r.id === id);
  if (!e) return null;
  const MAP: Record<string, WithdrawStatusCode> = {
    PROCESSING: "processing", WALLET_PROCESSING: "processing",
    SUCCESS: "success", FAILURE: "failed", CANCEL: "canceled",
  };
  return { id, status: MAP[e.status] ?? "pending", txId: e.hash, raw: e };
}

// ── Bitget ────────────────────────────────────────────────────────────────────

function bitgetHeaders(method: string, path: string, body = ""): Record<string, string> {
  const apiKey  = process.env.BITGET_API_KEY        ?? "";
  const secret  = process.env.BITGET_API_SECRET     ?? "";
  const phrase  = process.env.BITGET_API_PASSPHRASE ?? "";
  const ts      = Date.now().toString();
  const sign    = crypto.createHmac("sha256", secret).update(ts + method.toUpperCase() + path + body).digest("base64");
  return { "ACCESS-KEY": apiKey, "ACCESS-SIGN": sign, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": phrase, "Content-Type": "application/json" };
}

async function bitgetWithdraw(input: WithdrawInput): Promise<WithdrawResult> {
  if (!process.env.BITGET_API_KEY) throw new Error("Bitget API keys not configured");
  const path    = "/api/v2/spot/wallet/withdrawal";
  const payload: Record<string, unknown> = {
    coin: input.coin, transferType: "on_chain",
    address: input.address, chain: input.chainId, size: String(input.amount),
  };
  if (input.tag)      payload["tag"]      = input.tag;
  if (input.clientId) payload["clientOid"] = input.clientId;
  const bodyStr = JSON.stringify(payload);
  const res = await fetch(`https://api.bitget.com${path}`, {
    method: "POST", headers: bitgetHeaders("POST", path, bodyStr), body: bodyStr, signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json() as { code: string; msg?: string; data?: { orderId: string } };
  if (body.code !== "00000") throw new Error(`Bitget withdraw: ${body.code}: ${body.msg ?? ""}`);
  logger.info({ exchange: "bitget", coin: input.coin, chainId: input.chainId, withdrawalId: body.data?.orderId }, "withdrawal submitted");
  return { withdrawalId: body.data!.orderId, raw: body };
}

async function bitgetWithdrawStatus(coin: string, id: string): Promise<WithdrawStatus | null> {
  if (!process.env.BITGET_API_KEY) return null;
  const path = `/api/v2/spot/wallet/withdrawal-records?coin=${coin}&limit=50`;
  const res  = await fetch(`https://api.bitget.com${path}`, {
    headers: bitgetHeaders("GET", path), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = await res.json() as { code: string; data?: Array<{ orderId: string; status: string; txId?: string }> };
  if (body.code !== "00000") return null;
  const e = body.data?.find(r => r.orderId === id);
  if (!e) return null;
  const MAP: Record<string, WithdrawStatusCode> = {
    pending_review: "pending", pending_checking: "pending",
    success: "success", failed: "failed",
    wallet_processing: "processing", pending_fund_check: "pending",
  };
  return { id, status: MAP[e.status] ?? "pending", txId: e.txId, raw: e };
}

// ── Deposit tracking by blockchain txId ──────────────────────────────────────

export interface DepositStatus {
  status: "pending" | "processing" | "success" | "failed";
  amount?: number;
  raw?:    unknown;
}

async function binanceDepositByTxId(coin: string, txId: string): Promise<DepositStatus | null> {
  if (!process.env.BINANCE_API_KEY) return null;
  const ts  = Date.now();
  const qs  = `coin=${coin}&txId=${encodeURIComponent(txId)}&limit=50&timestamp=${ts}&recvWindow=5000`;
  const sig = binanceSign(qs);
  const res = await fetch(`https://api.binance.com/sapi/v1/capital/deposit/hisrec?${qs}&signature=${sig}`, {
    headers: binanceHeaders(), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const list = await res.json() as Array<{ txId: string; status: number; amount: string }>;
  const e = list.find(r => r.txId === txId);
  if (!e) return null;
  // Binance: 0=pending, 6=credited_not_distributed, 1=success
  const MAP: Record<number, DepositStatus["status"]> = { 0: "pending", 6: "processing", 1: "success" };
  return { status: MAP[e.status] ?? "pending", amount: parseFloat(e.amount), raw: e };
}

async function bybitDepositByTxId(coin: string, txId: string): Promise<DepositStatus | null> {
  if (!process.env.BYBIT_API_KEY) return null;
  const qs = `coin=${coin}&txID=${encodeURIComponent(txId)}`;
  const res = await fetch(`https://api.bybit.com/v5/asset/deposit/query-record?${qs}`, {
    headers: bybitQsHeaders(qs), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = await res.json() as { retCode: number; result?: { rows: Array<{ txID: string; status: number; amount: string }> } };
  if (body.retCode !== 0) return null;
  const e = body.result?.rows[0];
  if (!e) return null;
  // Bybit: 0=Unknown, 1=ToBeConfirmed, 2=Processing, 3=Success, 4=Failed
  const MAP: Record<number, DepositStatus["status"]> = { 0: "pending", 1: "pending", 2: "processing", 3: "success", 4: "failed" };
  return { status: MAP[e.status] ?? "pending", amount: parseFloat(e.amount), raw: e };
}

async function kucoinDepositByTxId(coin: string, txId: string): Promise<DepositStatus | null> {
  if (!process.env.KUCOIN_API_KEY) return null;
  const path = `/api/v1/deposits?currency=${coin}&pageSize=50`;
  const res  = await fetch(`https://api.kucoin.com${path}`, {
    headers: kucoinHeaders("GET", path), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = await res.json() as { code: string; data?: { items: Array<{ hash?: string; status: string; amount: string }> } };
  if (body.code !== "200000") return null;
  const e = body.data?.items.find(r => r.hash === txId);
  if (!e) return null;
  const MAP: Record<string, DepositStatus["status"]> = {
    PROCESSING: "processing", WALLET_PROCESSING: "processing",
    SUCCESS: "success", FAILURE: "failed",
  };
  return { status: MAP[e.status] ?? "pending", amount: parseFloat(e.amount), raw: e };
}

async function bitgetDepositByTxId(coin: string, txId: string): Promise<DepositStatus | null> {
  if (!process.env.BITGET_API_KEY) return null;
  const path = `/api/v2/spot/wallet/deposit-records?coin=${coin}&limit=50`;
  const res  = await fetch(`https://api.bitget.com${path}`, {
    headers: bitgetHeaders("GET", path), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = await res.json() as { code: string; data?: Array<{ txId?: string; status: string; size: string }> };
  if (body.code !== "00000") return null;
  const e = body.data?.find(r => r.txId === txId);
  if (!e) return null;
  const MAP: Record<string, DepositStatus["status"]> = {
    pending: "pending", success: "success", failed: "failed",
  };
  return { status: MAP[e.status] ?? "pending", amount: parseFloat(e.size), raw: e };
}

export async function getDepositByTxId(
  exchange: Exchange,
  coin:     string,
  txId:     string,
): Promise<DepositStatus | null> {
  switch (exchange) {
    case "binance": return binanceDepositByTxId(coin, txId);
    case "bybit":   return bybitDepositByTxId(coin, txId);
    case "kucoin":  return kucoinDepositByTxId(coin, txId);
    case "bitget":  return bitgetDepositByTxId(coin, txId);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function withdraw(exchange: Exchange, input: WithdrawInput): Promise<WithdrawResult> {
  switch (exchange) {
    case "binance": return binanceWithdraw(input);
    case "bybit":   return bybitWithdraw(input);
    case "kucoin":  return kucoinWithdraw(input);
    case "bitget":  return bitgetWithdraw(input);
  }
}

export async function getWithdrawStatus(
  exchange:     Exchange,
  coin:         string,
  withdrawalId: string,
): Promise<WithdrawStatus | null> {
  switch (exchange) {
    case "binance": return binanceWithdrawStatus(coin, withdrawalId);
    case "bybit":   return bybitWithdrawStatus(withdrawalId);
    case "kucoin":  return kucoinWithdrawStatus(coin, withdrawalId);
    case "bitget":  return bitgetWithdrawStatus(coin, withdrawalId);
  }
}
