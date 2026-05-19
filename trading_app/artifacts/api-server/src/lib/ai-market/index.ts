/**
 * AI Market Intelligence Service
 *
 * Connects to Ollama (Qwen 2.5 7B) running on VPS.
 * Aggregates market data from spot scanner and sends to AI for analysis.
 * Returns structured hedge suitability scores.
 */

import { logger } from "../logger.js";
import { spotScanner } from "../spot-scanner/index.js";
import { spotPriceHistory } from "../spot-scanner/price-history.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MarketState =
  | "SIDEWAYS_HEALTHY"
  | "HEALTHY_VOLATILE"
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "PUMPING"
  | "DUMPING"
  | "MANIPULATED"
  | "LOW_LIQUIDITY"
  | "HIGH_RISK"
  | "UNSTABLE";

export type Recommendation =
  | "SAFE_FOR_HEDGE"
  | "PROCEED_WITH_CAUTION"
  | "AVOID"
  | "HIGH_RISK_AVOID"
  | "MONITOR_ONLY";

export interface AiAnalysisResult {
  token:                string;
  exchangePair:         string;
  marketState:          MarketState;
  hedgeSuitabilityScore: number;
  riskLevel:            "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  spreadQuality:        "EXCELLENT" | "HEALTHY" | "MODERATE" | "POOR" | "DANGEROUS";
  inventoryRisk:        "LOW" | "MODERATE" | "HIGH";
  tradingEnvironment:   "EXCELLENT" | "GOOD" | "MODERATE" | "POOR" | "DANGEROUS";
  summary:              string;
  strengths:            string[];
  weaknesses:           string[];
  recommendation:       Recommendation;
  analyzedAt:           number;
  ollamaModel:          string;
}

export interface AiMarketInput {
  token:        string;
  exchangePair: string;
  movement:     { "4h": number; "8h": number; "12h": number; "24h": number };
  spread:       { avgPct: number; stdDev: number; persistenceSeconds: number; reversalCount: number };
  liquidity:    { score: number; orderbookDepth: number; stability: string };
  market:       { btcCorrelation: number; trendStrength: string; volatilityLevel: string };
  inventory:    { riskLevel: string; avgHoldMinutes: number };
}

// ── In-memory score cache ─────────────────────────────────────────────────────
// Stores latest AI score per token. Survives across requests.
const _scoreCache = new Map<string, AiAnalysisResult>();

export function getCachedScores(): AiAnalysisResult[] {
  return Array.from(_scoreCache.values()).sort(
    (a, b) => b.hedgeSuitabilityScore - a.hedgeSuitabilityScore,
  );
}

export function getCachedScore(token: string): AiAnalysisResult | undefined {
  return _scoreCache.get(token.toUpperCase());
}

// ── Ollama config ─────────────────────────────────────────────────────────────
function ollamaUrl(): string {
  return (process.env["OLLAMA_URL"] ?? "http://localhost:11434").replace(/\/$/, "");
}
function ollamaModel(): string {
  return process.env["OLLAMA_MODEL"] ?? "qwen2.5:7b";
}

// ── Health check ──────────────────────────────────────────────────────────────
export async function checkOllamaStatus(): Promise<{ connected: boolean; model: string; url: string; error?: string }> {
  const url   = ollamaUrl();
  const model = ollamaModel();
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    const loaded = models.some((n) => n.startsWith(model.split(":")[0]!));
    return { connected: true, model, url, error: loaded ? undefined : `Model '${model}' not found. Available: ${models.join(", ")}` };
  } catch (e) {
    return { connected: false, model, url, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Market data aggregation ───────────────────────────────────────────────────
function calcStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function buildMarketInput(token: string, buyExchange: string, sellExchange: string): AiMarketInput | null {
  const sym = token.toUpperCase();
  const opps = spotScanner.opportunities;

  // Find matching opportunity
  const opp = opps.find(
    (o) =>
      o.symbol.replace("/USDT", "") === sym &&
      ((o.buyExchange === buyExchange && o.sellExchange === sellExchange) ||
        (o.buyExchange === sellExchange && o.sellExchange === buyExchange)),
  ) ?? opps.find((o) => o.symbol.replace("/USDT", "") === sym);

  if (!opp) return null;

  // Price history for movement calc
  const history = spotPriceHistory.getHistory();
  const symKey  = `${sym}/USDT`;
  const now     = Date.now();

  function avgPriceAt(msAgo: number): number {
    const cutoff = now - msAgo;
    const rows = history.filter((r) => r.ts <= cutoff + 60_000 && r.ts >= cutoff - 5 * 60_000);
    if (!rows.length) return 0;
    const nearest = rows.reduce((a, b) => Math.abs(b.ts - cutoff) < Math.abs(a.ts - cutoff) ? b : a);
    const asks = nearest.asks[symKey];
    if (!asks) return 0;
    const vals = Object.values(asks).filter((v) => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }

  const priceCurrent = avgPriceAt(0) || opp.buyAsk;
  const price4h      = avgPriceAt(4  * 3600_000);
  const price8h      = avgPriceAt(8  * 3600_000);
  const price12h     = avgPriceAt(12 * 3600_000);
  const price24h     = avgPriceAt(24 * 3600_000);

  function movPct(base: number): number {
    if (!base || !priceCurrent) return 0;
    return Math.abs(((priceCurrent - base) / base) * 100);
  }

  // Spread history for variance / reversals
  const recentRows = history.slice(-120); // last ~1 hour of 30s snapshots
  const spreads: number[] = recentRows.map((r) => {
    const asks = r.asks[symKey];
    if (!asks) return 0;
    const vals = Object.values(asks).filter((v) => v > 0).sort();
    if (vals.length < 2) return 0;
    return ((vals[vals.length - 1]! - vals[0]!) / vals[0]!) * 100;
  }).filter((s) => s > 0);

  const avgSpreadPct = spreads.length
    ? spreads.reduce((a, b) => a + b, 0) / spreads.length
    : opp.priceDiffPct * 100;

  const spreadStdDev = calcStdDev(spreads);

  // Reversal count: count sign changes in spread deltas
  let reversalCount = 0;
  for (let i = 1; i < spreads.length; i++) {
    const prev = spreads[i - 1]! - (spreads[i - 2] ?? spreads[i - 1]!);
    const curr = spreads[i]! - spreads[i - 1]!;
    if (prev * curr < 0) reversalCount++;
  }

  // Liquidity score from orderbook depth
  const orderbookDepth = opp.allPrices
    ? Object.values(opp.allPrices).reduce((acc, p: { bid?: number; ask?: number }) => acc + (p.bid ?? 0) * 1000, 0)
    : 50_000;
  const liquidityScore = Math.min(10, orderbookDepth / 10_000);

  // Trend strength from 24h movement
  const mov24h  = movPct(price24h);
  const trendSt = mov24h > 15 ? "HIGH" : mov24h > 7 ? "MODERATE" : "LOW";

  // Volatility from spread std dev
  const volLevel = spreadStdDev > 1.5 ? "HIGH" : spreadStdDev > 0.5 ? "MODERATE" : "LOW";

  // BTC correlation — approximate from similar movement pattern (simplified)
  const btcCorrelation = 0.70 + Math.random() * 0.25; // placeholder; real impl needs BTC price

  return {
    token:        sym,
    exchangePair: `${buyExchange.charAt(0).toUpperCase()}${buyExchange.slice(1)}-${sellExchange.charAt(0).toUpperCase()}${sellExchange.slice(1)}`,
    movement: {
      "4h":  parseFloat(movPct(price4h).toFixed(2)),
      "8h":  parseFloat(movPct(price8h).toFixed(2)),
      "12h": parseFloat(movPct(price12h).toFixed(2)),
      "24h": parseFloat(mov24h.toFixed(2)),
    },
    spread: {
      avgPct:             parseFloat(avgSpreadPct.toFixed(3)),
      stdDev:             parseFloat(spreadStdDev.toFixed(3)),
      persistenceSeconds: Math.round(avgSpreadPct > 0.5 ? 10 : 3),
      reversalCount,
    },
    liquidity: {
      score:          parseFloat(liquidityScore.toFixed(1)),
      orderbookDepth: Math.round(orderbookDepth),
      stability:      liquidityScore > 7 ? "GOOD" : liquidityScore > 4 ? "MODERATE" : "POOR",
    },
    market: {
      btcCorrelation: parseFloat(btcCorrelation.toFixed(2)),
      trendStrength:  trendSt,
      volatilityLevel: volLevel,
    },
    inventory: {
      riskLevel:       opp.netProfitPct > 0.3 ? "LOW" : opp.netProfitPct > 0 ? "MODERATE" : "HIGH",
      avgHoldMinutes:  opp.netProfitPct > 0.5 ? 5 : opp.netProfitPct > 0.1 ? 15 : 30,
    },
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an advanced Crypto Market State AI for Spot Hedge Arbitrage analysis.

Your ONLY purpose is:
- market behavior analysis
- spread quality analysis
- hedge suitability scoring
- token health classification
- volatility assessment
- inventory risk analysis
- market state classification

Market state options: SIDEWAYS_HEALTHY, HEALTHY_VOLATILE, TRENDING_UP, TRENDING_DOWN, PUMPING, DUMPING, MANIPULATED, LOW_LIQUIDITY, HIGH_RISK, UNSTABLE

Hedge suitability score: 0-10
- 0-3: Unsafe
- 4-5: High Risk
- 6-7: Moderate
- 8-9: Strong Hedge Candidate
- 10: Exceptional

DANGEROUS conditions: 4H movement > 8%, strong directional trends, unstable spreads, low liquidity.
IDEAL conditions: stable oscillation, repeated reversals, controlled volatility, healthy liquidity.

You MUST respond with ONLY valid JSON matching this exact schema:
{
  "token": string,
  "marketState": string,
  "hedgeSuitabilityScore": number,
  "riskLevel": "LOW" | "MODERATE" | "HIGH" | "CRITICAL",
  "spreadQuality": "EXCELLENT" | "HEALTHY" | "MODERATE" | "POOR" | "DANGEROUS",
  "inventoryRisk": "LOW" | "MODERATE" | "HIGH",
  "tradingEnvironment": "EXCELLENT" | "GOOD" | "MODERATE" | "POOR" | "DANGEROUS",
  "summary": string,
  "strengths": string[],
  "weaknesses": string[],
  "recommendation": "SAFE_FOR_HEDGE" | "PROCEED_WITH_CAUTION" | "AVOID" | "HIGH_RISK_AVOID" | "MONITOR_ONLY"
}

No explanation, no markdown — ONLY the JSON object.`;

// ── Ollama call ───────────────────────────────────────────────────────────────
async function callOllama(input: AiMarketInput): Promise<AiAnalysisResult> {
  const url   = ollamaUrl();
  const model = ollamaModel();

  const prompt = `${SYSTEM_PROMPT}\n\nAnalyze this token market data:\n${JSON.stringify(input, null, 2)}`;

  const res = await fetch(`${url}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);

  const raw = await res.json() as { response?: string; error?: string };
  if (raw.error) throw new Error(`Ollama error: ${raw.error}`);

  // Extract JSON from response (strip any markdown fences)
  let responseText = (raw.response ?? "").trim();
  const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) responseText = fenceMatch[1]!.trim();
  const jsonStart = responseText.indexOf("{");
  const jsonEnd   = responseText.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    responseText = responseText.slice(jsonStart, jsonEnd + 1);
  }

  const parsed = JSON.parse(responseText) as Partial<AiAnalysisResult>;

  return {
    token:                 input.token,
    exchangePair:          input.exchangePair,
    marketState:           parsed.marketState           ?? "UNSTABLE",
    hedgeSuitabilityScore: parsed.hedgeSuitabilityScore ?? 0,
    riskLevel:             parsed.riskLevel             ?? "HIGH",
    spreadQuality:         parsed.spreadQuality         ?? "POOR",
    inventoryRisk:         parsed.inventoryRisk         ?? "HIGH",
    tradingEnvironment:    parsed.tradingEnvironment    ?? "POOR",
    summary:               parsed.summary               ?? "Analysis unavailable",
    strengths:             parsed.strengths             ?? [],
    weaknesses:            parsed.weaknesses            ?? [],
    recommendation:        parsed.recommendation        ?? "AVOID",
    analyzedAt:            Date.now(),
    ollamaModel:           model,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Analyze a single token. Returns cached result if < 10 min old. */
export async function analyzeToken(
  token: string,
  buyExchange = "binance",
  sellExchange = "bybit",
  forceRefresh = false,
): Promise<AiAnalysisResult> {
  const sym    = token.toUpperCase();
  const cached = _scoreCache.get(sym);
  const AGE_MS = 10 * 60_000; // 10 minutes

  if (!forceRefresh && cached && Date.now() - cached.analyzedAt < AGE_MS) {
    return cached;
  }

  const input = buildMarketInput(sym, buyExchange, sellExchange);
  if (!input) throw new Error(`No market data found for token: ${sym}`);

  logger.info({ token: sym }, "ai-market: calling Ollama");
  const result = await callOllama(input);
  _scoreCache.set(sym, result);
  logger.info({ token: sym, score: result.hedgeSuitabilityScore, state: result.marketState }, "ai-market: analysis complete");
  return result;
}

/** Analyze top N opportunities from spot scanner. */
export async function scanAllOpportunities(limit = 10): Promise<AiAnalysisResult[]> {
  const opps = spotScanner.opportunities
    .filter((o) => o.netProfitPct > 0)
    .sort((a, b) => b.netProfitPct - a.netProfitPct)
    .slice(0, limit);

  const results: AiAnalysisResult[] = [];

  for (const opp of opps) {
    const sym = opp.symbol.replace("/USDT", "");
    try {
      const result = await analyzeToken(sym, opp.buyExchange, opp.sellExchange);
      results.push(result);
    } catch (e) {
      logger.warn({ token: sym, err: String(e) }, "ai-market: skip token (error)");
    }
  }

  return results.sort((a, b) => b.hedgeSuitabilityScore - a.hedgeSuitabilityScore);
}
