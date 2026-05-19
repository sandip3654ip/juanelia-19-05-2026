import { useMemo, useRef, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, ChevronUp, X, Play, RefreshCw, CheckCircle, AlertTriangle, Zap, LineChart as LineChartIcon, BarChart2, Brain } from "lucide-react";
import { ExchangeIcon } from "@/components/ExchangeIcon";
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid,
} from "recharts";

const TRADE_BTN_STYLES = `
  @keyframes tradeShimmer {
    0%   { background-position: 200% center; }
    100% { background-position: -200% center; }
  }
  .trade-btn {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 3px 7px;
    border: 1px solid rgba(139,92,246,0.5);
    border-radius: 6px;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.07em;
    cursor: pointer;
    color: #ede9fe;
    background: linear-gradient(270deg, #4f46e5, #7c3aed, #6366f1, #7c3aed, #4f46e5);
    background-size: 300% 100%;
    animation: tradeShimmer 5s linear infinite;
    transition: transform 0.13s, filter 0.13s, box-shadow 0.13s;
  }
  .trade-btn:hover {
    transform: scale(1.07);
    filter: brightness(1.18);
    box-shadow: 0 2px 10px rgba(99,102,241,0.45);
    animation: tradeShimmer 2s linear infinite;
  }
  .trade-btn:active {
    transform: scale(0.95);
    filter: brightness(0.9);
  }
  .trade-btn .trade-icon {
    transition: transform 0.13s;
  }
  .trade-btn:hover .trade-icon {
    transform: translateX(1px);
  }
`;

const EXCHANGES  = ["binance", "bybit", "kucoin", "bitget"];
const TIMELINES  = ["4H", "8H", "12H", "24H", ];

const DEFAULT_SORT = "crossovers";

function fmtPct(v, digits = 3) {
  if (v == null || !isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function fmtCrossTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 60_000)    return `${Math.round(diff / 1_000)}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  return `${(diff / 3_600_000).toFixed(1)}h`;
}

function fmtDuration(ms) {
  if (ms == null || ms <= 0) return null;
  const s = Math.round(ms / 1_000);
  if (s < 60)  return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60)  return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24)  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}
function exLabel(n) { return n ? n.charAt(0).toUpperCase() + n.slice(1) : "—"; }

const EX_COLORS = { binance: "#F3BA2F", bybit: "#FFC200", kucoin: "#0DBB6F", bitget: "#00C6FF" };
function exColor(n) { return EX_COLORS[n] ?? "#94a3b8"; }

function mvColor(v) {
  if (v == null) return "var(--app-text-muted)";
  const a = Math.abs(v);
  if (a >= 3) return "#f87171";
  if (a >= 1) return "#fbbf24";
  return "#4ade80";
}

// ── AI Score helpers ─────────────────────────────────────────────────────────
function aiScoreColor(score) {
  if (score == null) return { bg: "rgba(148,163,184,0.08)", border: "rgba(148,163,184,0.2)", text: "#64748b", glow: "none" };
  if (score >= 10)   return { bg: "rgba(168,85,247,0.18)",  border: "rgba(168,85,247,0.5)",  text: "#d946ef", glow: "0 0 8px rgba(168,85,247,0.4)" };
  if (score >= 8)    return { bg: "rgba(74,222,128,0.15)",  border: "rgba(74,222,128,0.45)", text: "#4ade80", glow: "0 0 6px rgba(74,222,128,0.25)" };
  if (score >= 6)    return { bg: "rgba(251,191,36,0.12)",  border: "rgba(251,191,36,0.4)",  text: "#fbbf24", glow: "none" };
  if (score >= 4)    return { bg: "rgba(249,115,22,0.12)",  border: "rgba(249,115,22,0.4)",  text: "#fb923c", glow: "none" };
  return               { bg: "rgba(248,113,113,0.10)",  border: "rgba(248,113,113,0.35)", text: "#f87171", glow: "none" };
}

function aiScoreLabel(score) {
  if (score == null) return null;
  if (score >= 10)   return "EXCEPTIONAL";
  if (score >= 8)    return "STRONG";
  if (score >= 6)    return "MODERATE";
  if (score >= 4)    return "HIGH RISK";
  return               "UNSAFE";
}

function AiScoreBadge({ score, loading }) {
  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <RefreshCw size={11} style={{ animation: "spin 1s linear infinite", color: "#475569" }} />
        <span style={{ fontSize: 8, color: "#475569", fontWeight: 600 }}>SCORING</span>
      </div>
    );
  }
  if (score == null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <Brain size={12} style={{ color: "#334155" }} />
        <span style={{ fontSize: 8, color: "#334155", fontWeight: 600 }}>PENDING</span>
      </div>
    );
  }
  const { bg, border, text, glow } = aiScoreColor(score);
  const label = aiScoreLabel(score);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <div style={{
        background: bg, border: `1px solid ${border}`,
        borderRadius: 8, padding: "3px 8px", boxShadow: glow,
        display: "flex", alignItems: "center", gap: 4,
      }}>
        <Brain size={10} style={{ color: text, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 900, fontFamily: "monospace", color: text, lineHeight: 1 }}>
          {score}
        </span>
        <span style={{ fontSize: 8, fontWeight: 600, color: text, lineHeight: 1, opacity: 0.7 }}>/10</span>
      </div>
      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.04em", color: text, lineHeight: 1 }}>
        {label}
      </span>
    </div>
  );
}

function durationLabel(ms) {
  if (!ms || ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 > 0 ? `${m % 60}m` : ""}`;
}

const btnBase = {
  background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)",
  color: "var(--app-text-muted)", borderRadius: 8, padding: "3px 10px",
  fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "monospace",
  letterSpacing: "0.04em", transition: "all 0.12s", whiteSpace: "nowrap",
};
const btnActive = {
  background: "var(--app-success-soft, rgba(34,197,94,0.12))",
  border: "1px solid var(--app-success-border, rgba(34,197,94,0.4))",
  color: "var(--app-success, #4ade80)",
};
const selStyle = {
  background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)",
  color: "var(--app-text-muted)", borderRadius: 8, padding: "3px 7px",
  fontSize: 11, fontWeight: 600, cursor: "pointer", outline: "none",
};
const lblStyle = {
  color: "var(--app-text-muted)", fontSize: 10, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0,
};
const dividerStyle = {
  width: 1, height: 18, background: "var(--app-border-1)", margin: "0 4px", flexShrink: 0,
};
const hdrCell = {
  fontSize: 10, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.07em", color: "var(--app-text-muted)",
};

function Btn({ active, onClick, children, style = {} }) {
  return (
    <button onClick={onClick} style={{ ...btnBase, ...(active ? btnActive : {}), ...style }}>
      {children}
    </button>
  );
}

// ── Trade Setup Modal ────────────────────────────────────────────────────────
function TradeModal({ opp, liveOpps = [], onClose }) {
  const [amtUsdt,      setAmtUsdt]      = useState(100);
  const [maxSpread,    setMaxSpread]    = useState(1.5);
  const [targetNet,    setTargetNet]    = useState(0.5);
  const [countTrades,  setCountTrades]  = useState(1);
  const [flipInterval, setFlipInterval] = useState(5);
  const [maxLossUsdt,  setMaxLossUsdt]  = useState(5);
  const [loading,      setLoading]      = useState(false);
  const [msg,          setMsg]          = useState(null);

  // Follow the live version of this opp so prices update in real-time
  const liveOpp = useMemo(() => {
    const match = liveOpps.find(
      (o) => o.symbol === opp.symbol &&
             o.buyExchange === opp.buyExchange &&
             o.sellExchange === opp.sellExchange,
    );
    return match ?? opp;
  }, [liveOpps, opp]);

  const priceMap = useMemo(() => {
    const m = {};
    for (const p of (liveOpp.allPrices ?? [])) m[p.exchange] = p;
    return m;
  }, [liveOpp.allPrices]);

  const buyPrice  = priceMap[opp.buyExchange];
  const sellPrice = priceMap[opp.sellExchange];

  async function handleStart() {
    setLoading(true); setMsg(null);
    try {
      const res = await fetch("/api/spot-hedge/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token:              opp.symbol,
          exchangeA:          opp.buyExchange,
          exchangeB:          opp.sellExchange,
          tradeAmountUsdt:     amtUsdt,
          minSpreadPct:        targetNet,
          neutralThresholdPct: maxSpread,
          maxRounds:           countTrades,
          flipIntervalSec:     flipInterval,
          maxLossUsdt:         maxLossUsdt,
          dryRun:              false,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMsg({ ok: true, text: "Bot started — switch to Scanner tab to monitor" });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setLoading(false);
    }
  }

  const inputStyle = {
    background: "var(--app-bg)", border: "1px solid var(--app-border-1)",
    borderRadius: 8, padding: "7px 10px", fontSize: 13, fontFamily: "monospace",
    fontWeight: 700, color: "var(--app-text-primary)", outline: "none", width: "100%",
  };
  const labelStyle = {
    fontSize: 10, fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.06em", color: "var(--app-text-dim)",
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.65)", backdropFilter: "blur(3px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "16px",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--app-surface-1)", border: "1px solid var(--app-border-1)",
          borderRadius: 16, padding: "24px", width: "100%", maxWidth: 440,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          display: "flex", flexDirection: "column", gap: 20,
        }}
      >
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: "var(--app-text-bright)" }}>
              Trade Setup
            </span>
            {/* Symbol chip */}
            <span style={{
              background: "rgba(99,102,241,0.18)", border: "1px solid rgba(99,102,241,0.4)",
              color: "#a5b4fc", borderRadius: 6, padding: "2px 10px", alignSelf: "flex-start",
              fontSize: 13, fontWeight: 900, fontFamily: "monospace",
            }}>{opp.symbol}</span>
          </div>
          <button onClick={onClose} style={{
            background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)",
            borderRadius: 8, padding: "5px 7px", cursor: "pointer", color: "var(--app-text-muted)",
            display: "flex", alignItems: "center",
          }}>
            <X size={14} />
          </button>
        </div>

        {/* Exchange price cards */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, alignItems: "center" }}>
          {/* Buy side */}
          <div style={{
            background: "var(--app-bg)", border: "1px solid rgba(74,222,128,0.2)",
            borderRadius: 10, padding: "10px 14px",
            display: "flex", flexDirection: "column", gap: 4,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <ExchangeIcon name={opp.buyExchange} size={14} />
              <span style={{ fontSize: 11, fontWeight: 800, color: exColor(opp.buyExchange) }}>
                {exLabel(opp.buyExchange)}
              </span>
              <span style={{
                fontSize: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
                color: "#4ade80", background: "rgba(74,222,128,0.12)",
                border: "1px solid rgba(74,222,128,0.25)", borderRadius: 4, padding: "1px 5px",
              }}>BUY</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 9, color: "var(--app-text-muted)", fontWeight: 600 }}>Ask</span>
              <span style={{ fontSize: 13, fontWeight: 800, fontFamily: "monospace", color: "#4ade80" }}>
                {buyPrice?.ask != null ? buyPrice.ask.toPrecision(6) : "—"}
              </span>
            </div>
          </div>

          <ArrowRight size={14} style={{ color: "var(--app-text-muted)", flexShrink: 0 }} />

          {/* Sell side */}
          <div style={{
            background: "var(--app-bg)", border: "1px solid rgba(248,113,113,0.2)",
            borderRadius: 10, padding: "10px 14px",
            display: "flex", flexDirection: "column", gap: 4,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <ExchangeIcon name={opp.sellExchange} size={14} />
              <span style={{ fontSize: 11, fontWeight: 800, color: exColor(opp.sellExchange) }}>
                {exLabel(opp.sellExchange)}
              </span>
              <span style={{
                fontSize: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
                color: "#f87171", background: "rgba(248,113,113,0.12)",
                border: "1px solid rgba(248,113,113,0.25)", borderRadius: 4, padding: "1px 5px",
              }}>SELL</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 9, color: "var(--app-text-muted)", fontWeight: 600 }}>Bid</span>
              <span style={{ fontSize: 13, fontWeight: 800, fontFamily: "monospace", color: "#f87171" }}>
                {sellPrice?.bid != null ? sellPrice.bid.toPrecision(6) : "—"}
              </span>
            </div>
          </div>
        </div>

        {/* 4 inputs */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={labelStyle}>Trade Amount</label>
            <div style={{ position: "relative" }}>
              <input type="number" value={amtUsdt} onChange={(e) => setAmtUsdt(Number(e.target.value))}
                min={10} step={10} style={inputStyle} />
              <span style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)",
                fontSize: 10, fontWeight: 700, color: "var(--app-text-muted)", pointerEvents: "none" }}>USDT</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={labelStyle}>Entry/Exit Spread Max</label>
            <div style={{ position: "relative" }}>
              <input type="number" value={maxSpread} onChange={(e) => setMaxSpread(Number(e.target.value))}
                min={0.1} step={0.1} style={inputStyle} />
              <span style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)",
                fontSize: 10, fontWeight: 700, color: "var(--app-text-muted)", pointerEvents: "none" }}>%</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={labelStyle}>Target Net Profit %</label>
            <div style={{ position: "relative" }}>
              <input type="number" value={targetNet} onChange={(e) => setTargetNet(Number(e.target.value))}
                min={0.01} step={0.05} style={inputStyle} />
              <span style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)",
                fontSize: 10, fontWeight: 700, color: "var(--app-text-muted)", pointerEvents: "none" }}>%</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={labelStyle}>Count Of Trades</label>
            <input type="number" value={countTrades} onChange={(e) => setCountTrades(Number(e.target.value))}
              min={1} step={1} style={inputStyle} />
          </div>

          {/* Flip interval — full width */}
          <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={labelStyle}>
              Trade Flipping Interval
              <span style={{ fontSize: 9, marginLeft: 6, color: "var(--app-text-dim)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                — cooldown between rounds (safety buffer)
              </span>
            </label>
            <div style={{ position: "relative" }}>
              <input
                type="number"
                value={flipInterval}
                onChange={(e) => setFlipInterval(Math.max(0, Number(e.target.value)))}
                min={0} step={1}
                style={inputStyle}
              />
              <span style={{
                position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)",
                fontSize: 10, fontWeight: 700, color: "var(--app-text-muted)", pointerEvents: "none",
              }}>SEC</span>
            </div>
            <div style={{ fontSize: 10, color: "var(--app-text-dim)", lineHeight: 1.4 }}>
              {flipInterval === 0
                ? "No cooldown — next round fires immediately after previous completes"
                : `After each round, next round unlocks after ${flipInterval}s`}
            </div>
          </div>

          {/* Max Loss — full width */}
          <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={labelStyle}>
              Max Loss USDT
              <span style={{ fontSize: 9, marginLeft: 6, color: "var(--app-text-dim)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                — circuit breaker: auto-exit if session loss reaches this (0 = disabled)
              </span>
            </label>
            <div style={{ position: "relative" }}>
              <input
                type="number"
                value={maxLossUsdt}
                onChange={(e) => setMaxLossUsdt(Math.max(0, Number(e.target.value)))}
                min={0} step={1}
                style={inputStyle}
              />
              <span style={{
                position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)",
                fontSize: 10, fontWeight: 700, color: "var(--app-text-muted)", pointerEvents: "none",
              }}>USDT</span>
            </div>
            <div style={{ fontSize: 10, color: "var(--app-text-dim)", lineHeight: 1.4 }}>
              {maxLossUsdt === 0
                ? "Disabled — bot will run until max rounds or manual stop"
                : `Bot auto-exits if net loss ≥ ${maxLossUsdt} USDT this session`}
            </div>
          </div>
        </div>

        {/* Message */}
        {msg && (
          <div style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            padding: "8px 12px", borderRadius: 8, fontSize: 12,
            background: msg.ok ? "var(--app-success-soft)" : "rgba(248,113,113,0.1)",
            color:      msg.ok ? "var(--app-success)"      : "#f87171",
            border:     `1px solid ${msg.ok ? "var(--app-success-border)" : "rgba(248,113,113,0.3)"}`,
          }}>
            {msg.ok
              ? <CheckCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              : <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />}
            {msg.text}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{
            flex: "0 0 auto", padding: "9px 18px", borderRadius: 8, fontSize: 13,
            fontWeight: 700, cursor: "pointer",
            background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)",
            color: "var(--app-text-muted)",
          }}>
            Cancel
          </button>
          <button onClick={handleStart} disabled={loading || msg?.ok} style={{
            flex: 1, padding: "9px 0", borderRadius: 8, fontSize: 13,
            fontWeight: 800, cursor: loading || msg?.ok ? "not-allowed" : "pointer",
            background: "var(--app-success)", color: "#000",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            opacity: loading || msg?.ok ? 0.6 : 1, transition: "opacity 0.15s",
          }}>
            {loading
              ? <><RefreshCw size={14} style={{ animation: "spin 1s linear infinite" }} /> Starting…</>
              : <><Play size={14} /> Start Bot</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function findClosest(sorted, ts) {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].ts < ts) lo = mid + 1; else hi = mid;
  }
  return sorted[lo];
}

function downsample(arr, maxPts = 300) {
  const n = Math.max(1, Math.ceil(arr.length / maxPts));
  return arr.filter((_, i) => i % n === 0);
}

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const fmtPrice = (v) =>
  v == null ? "—" : v < 0.01 ? v.toFixed(6) : v < 1 ? v.toFixed(4) : v.toFixed(3);

const CHART_TOOLTIP_STYLE = {
  background: "var(--app-surface-1)", border: "1px solid var(--app-border-1)",
  borderRadius: 8, fontSize: 11, color: "var(--app-text-primary)",
};

// ── Inline Charts (shown inside expanded row) ─────────────────────────────
function ExpandedCharts({ opp, enabled }) {
  const [tab, setTab] = useState("spread");

  const { data: askData, isLoading: askLoading } = useQuery({
    queryKey: ["sparklines-full-ask", opp.symbol],
    queryFn: async () => {
      const r = await fetch(`/api/spot/sparklines-full?symbol=${encodeURIComponent(opp.symbol)}`);
      return r.ok ? r.json() : {};
    },
    staleTime: 60_000,
  });

  const { data: bidData, isLoading: bidLoading } = useQuery({
    queryKey: ["sparklines-full-bid", opp.symbol],
    queryFn: async () => {
      const r = await fetch(`/api/spot/sparklines-full-bid?symbol=${encodeURIComponent(opp.symbol)}`);
      return r.ok ? r.json() : {};
    },
    staleTime: 60_000,
  });

  const loading = askLoading || bidLoading;

  const chartData = useMemo(() => {
    if (!askData || !bidData) return [];
    const askSeries = askData[opp.buyExchange] ?? [];
    const bidSeries = bidData[opp.sellExchange] ?? [];
    if (!askSeries.length || !bidSeries.length) return [];
    const sampled   = downsample(askSeries, 400);
    const sortedBid = [...bidSeries].sort((a, b) => a.ts - b.ts);
    return sampled.map((pt) => {
      const bidPt   = findClosest(sortedBid, pt.ts);
      const buyAsk  = pt.price;
      const sellBid = bidPt?.price ?? null;
      const spread  = sellBid != null ? ((sellBid - buyAsk) / buyAsk * 100) : null;
      return { ts: pt.ts, buyAsk, sellBid, spread };
    });
  }, [askData, bidData, opp.buyExchange, opp.sellExchange]);

  const spreadVals   = chartData.map(d => d.spread).filter(v => v != null);
  const spreadMin    = spreadVals.length ? Math.min(...spreadVals) : 0;
  const spreadMax    = spreadVals.length ? Math.max(...spreadVals) : 0;
  const spreadAvg    = spreadVals.length ? spreadVals.reduce((a, b) => a + b, 0) / spreadVals.length : 0;
  const posCount     = spreadVals.filter(v => v > 0).length;
  const spreadDomain = [
    Math.floor((spreadMin - Math.abs(spreadMin) * 0.05) * 1000) / 1000,
    Math.ceil( (spreadMax + Math.abs(spreadMax) * 0.05) * 1000) / 1000,
  ];

  const axisProps = { tick: { fill: "#475569", fontSize: 9 }, tickLine: false, axisLine: false };
  const cm        = { top: 6, right: 14, left: 0, bottom: 0 };
  const symId     = opp.symbol.replace(/[^a-zA-Z0-9]/g, "_");

  if (!enabled) return null;

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 64, gap: 8 }}>
        <RefreshCw size={12} style={{ animation: "spin 1s linear infinite", color: "#475569" }} />
        <span style={{ fontSize: 11, color: "#475569" }}>Loading charts…</span>
      </div>
    );
  }

  if (!chartData.length) return null;

  return (
    <div style={{ width: "100%", marginTop: 12 }}>
      {/* Tab strip */}
      <div style={{ display: "flex", gap: 0, borderRadius: 8, overflow: "hidden", border: "1px solid var(--app-border-0)", alignSelf: "flex-start", width: "fit-content", marginBottom: 10 }}>
        {[
          { key: "spread", label: "Spread %",        icon: <BarChart2 size={11} /> },
          { key: "price",  label: "Price Crossover", icon: <LineChartIcon size={11} /> },
        ].map(({ key, label, icon }, i) => (
          <button key={key} onClick={() => setTab(key)} style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "4px 12px", fontSize: 10, fontWeight: 700, cursor: "pointer",
            border: "none",
            background: tab === key ? "rgba(99,102,241,0.2)" : "transparent",
            color:      tab === key ? "#a5b4fc"              : "#475569",
            borderRight: i === 0 ? "1px solid var(--app-border-0)" : "none",
            transition: "all 0.12s",
          }}>
            {icon}{label}
          </button>
        ))}
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 16, marginBottom: 8, flexWrap: "wrap" }}>
        {tab === "spread" ? <>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", color: "#475569" }}>Peak</span>
            <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "monospace", color: "#4ade80" }}>+{spreadMax.toFixed(3)}%</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", color: "#475569" }}>Avg</span>
            <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "monospace", color: spreadAvg >= 0 ? "#4ade80" : "#f87171" }}>{spreadAvg >= 0 ? "+" : ""}{spreadAvg.toFixed(3)}%</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", color: "#475569" }}>Min</span>
            <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "monospace", color: spreadMin >= 0 ? "#94a3b8" : "#f87171" }}>{spreadMin.toFixed(3)}%</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", color: "#475569" }}>% Time Pos</span>
            <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "monospace", color: "#a5b4fc" }}>{spreadVals.length ? `${((posCount / spreadVals.length) * 100).toFixed(1)}%` : "—"}</span>
          </div>
        </> : <>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 2, background: exColor(opp.buyExchange), display: "inline-block" }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: exColor(opp.buyExchange) }}>{exLabel(opp.buyExchange)} Ask</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 2, background: exColor(opp.sellExchange), borderTop: `2px dashed ${exColor(opp.sellExchange)}`, display: "inline-block" }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: exColor(opp.sellExchange) }}>{exLabel(opp.sellExchange)} Bid</span>
          </div>
        </>}
        <span style={{ marginLeft: "auto", fontSize: 9, color: "#334155", alignSelf: "flex-end" }}>{chartData.length} pts</span>
      </div>

      {/* Chart */}
      <div style={{ height: 190 }}>
        {tab === "spread" ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={cm}>
              <defs>
                <linearGradient id={`sp_${symId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#4ade80" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#4ade80" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id={`spn_${symId}`} x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%"   stopColor="#f87171" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="#f87171" stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 5" stroke="rgba(255,255,255,0.03)" vertical={false} />
              <XAxis dataKey="ts" tickFormatter={fmtTime} {...axisProps} interval="preserveStartEnd" tickMargin={4} />
              <YAxis domain={spreadDomain} tickFormatter={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`} {...axisProps} width={52} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={fmtTime}
                formatter={(v) => [v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(4)}%` : "—", "Spread"]}
                cursor={{ stroke: "rgba(165,180,252,0.25)", strokeWidth: 1 }} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 3" />
              <Area type="monotone" dataKey="spread" stroke="#4ade80" strokeWidth={1.5}
                fill={spreadAvg >= 0 ? `url(#sp_${symId})` : `url(#spn_${symId})`}
                dot={false} activeDot={{ r: 3, fill: "#4ade80", strokeWidth: 0 }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={cm}>
              <CartesianGrid strokeDasharray="2 5" stroke="rgba(255,255,255,0.03)" vertical={false} />
              <XAxis dataKey="ts" tickFormatter={fmtTime} {...axisProps} interval="preserveStartEnd" tickMargin={4} />
              <YAxis tickFormatter={fmtPrice} {...axisProps} width={60} domain={["auto", "auto"]} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={fmtTime}
                formatter={(v, name) => [fmtPrice(v), name]}
                cursor={{ stroke: "rgba(165,180,252,0.25)", strokeWidth: 1 }} />
              <Line type="monotone" dataKey="buyAsk" name={`${exLabel(opp.buyExchange)} Ask`}
                stroke={exColor(opp.buyExchange)} strokeWidth={1.5}
                dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
              <Line type="monotone" dataKey="sellBid" name={`${exLabel(opp.sellExchange)} Bid`}
                stroke={exColor(opp.sellExchange)} strokeWidth={1.5} strokeDasharray="5 3"
                dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Chart Overlay Modal ───────────────────────────────────────────────────
function ChartOverlayModal({ opp, onClose }) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 120,
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--app-bg)", border: "1px solid var(--app-border-1)",
        borderRadius: 16, width: "100%", maxWidth: 800,
        boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 20px",
          background: "var(--app-surface-1)",
          borderBottom: "1px solid var(--app-border-0)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ExchangeIcon name={opp.buyExchange} size={16} />
            <span style={{ fontSize: 12, fontWeight: 700, color: exColor(opp.buyExchange) }}>{exLabel(opp.buyExchange)}</span>
            <ArrowRight size={11} style={{ color: "var(--app-text-muted)" }} />
            <ExchangeIcon name={opp.sellExchange} size={16} />
            <span style={{ fontSize: 12, fontWeight: 700, color: exColor(opp.sellExchange) }}>{exLabel(opp.sellExchange)}</span>
            <span style={{
              background: "rgba(99,102,241,0.18)", border: "1px solid rgba(99,102,241,0.4)",
              color: "#a5b4fc", borderRadius: 6, padding: "2px 9px",
              fontSize: 13, fontWeight: 900, fontFamily: "monospace", marginLeft: 2,
            }}>{opp.symbol}</span>
          </div>
          <button onClick={onClose} style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28, borderRadius: 8, cursor: "pointer",
            background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)",
            color: "var(--app-text-muted)",
          }}><X size={13} /></button>
        </div>
        {/* Chart content */}
        <div style={{ padding: "16px 20px 20px" }}>
          <ExpandedCharts opp={opp} enabled={true} />
        </div>
      </div>
    </div>
  );
}

export function SpotHedgePotentialTab({ spotOpportunities = [] }) {
  const [exchA,           setExchA]           = useState("any");
  const [exchB,           setExchB]           = useState("any");
  const [minPeak,         setMinPeak]         = useState(0);
  const [maxMove,         setMaxMove]         = useState("");
  const [movTimeline,     setMovTimeline]     = useState("any");
  const [expanded,        setExpanded]        = useState(null);
  const [tradeOpp,        setTradeOpp]        = useState(null);
  const [chartOpp,        setChartOpp]        = useState(null);

  const stableOrderRef  = useRef([]);
  const lastSortKeyRef  = useRef("");
  const lastKnownRef    = useRef(new Map());

  const [peakMode,        setPeakMode]        = useState("net");
  const [peakFilter,      setPeakFilter]      = useState(false);
  const [targetInput,     setTargetInput]     = useState("0.50");
  const [targetNet,       setTargetNet]       = useState(0.50);

  const { data: priceMovements = {} } = useQuery({
    queryKey: ["spot-price-movements"],
    queryFn: async () => {
      const res = await fetch("/api/spot/price-movements");
      if (!res.ok) return {};
      return res.json();
    },
    staleTime: 30_000, refetchInterval: 60_000,
  });

  const { data: crossoversData = {} } = useQuery({
    queryKey: ["spot-crossovers"],
    queryFn: async () => {
      const res = await fetch("/api/spot/crossovers?maxEvents=10");
      if (!res.ok) return {};
      return res.json();
    },
    staleTime: 15_000, refetchInterval: 30_000,
  });

  // ── AI Scores (auto-refresh every 60s) ───────────────────────────────────
  const { data: aiScoresRaw = {}, isFetching: aiScoresFetching } = useQuery({
    queryKey: ["ai-scores"],
    queryFn: async () => {
      const res = await fetch("/api/ai/scores");
      if (!res.ok) return {};
      const json = await res.json();
      // Backend returns AiAnalysisResult[] sorted by hedgeSuitabilityScore desc
      // Cache key = token symbol (e.g. "BTC"), value = score 0-10
      const arr = Array.isArray(json) ? json : [];
      const map = {};
      for (const s of arr) {
        if (s.token) map[s.token.toUpperCase()] = s.hedgeSuitabilityScore ?? null;
      }
      return map;
    },
    staleTime: 55_000,
    refetchInterval: 60_000,
  });

  // Auto-trigger AI scan every 60s so scores stay fresh
  useEffect(() => {
    const runScan = () => fetch("/api/ai/scan", { method: "POST" }).catch(() => {});
    runScan();
    const timer = setInterval(runScan, 60_000);
    return () => clearInterval(timer);
  }, []);

  const maxMoveParsed = maxMove !== "" ? parseFloat(maxMove) : null;

  const sorted = useMemo(() => {
    const oKey = (o) => `${o.symbol}|${o.buyExchange}|${o.sellExchange}`;

    for (const o of spotOpportunities) lastKnownRef.current.set(oKey(o), o);

    const sortKey = `${exchA}|${exchB}|${minPeak}|${maxMoveParsed}|${movTimeline}|${peakFilter}|${peakMode}|${targetNet}`;
    const needsResort = sortKey !== lastSortKeyRef.current || stableOrderRef.current.length === 0;

    if (needsResort) {
      const filtered = [...spotOpportunities].filter((o) => {
        if (exchA !== "any" && o.buyExchange !== exchA) return false;
        if (exchB !== "any" && o.sellExchange !== exchB) return false;
        if (minPeak > 0 && (o.highestNetProfitPct ?? 0) < minPeak) return false;
        if (maxMoveParsed != null) {
          const tls = movTimeline === "any" ? TIMELINES : [movTimeline];
          if (tls.some((tl) => { const mv = priceMovements[o.symbol]?.[tl]; return mv != null && Math.abs(mv) > maxMoveParsed; })) return false;
        }
        if (peakFilter) {
          const evts  = crossoversData[oKey(o)]?.events ?? [];
          const valFn = (ev) => peakMode === "spread" ? (ev.peakSpreadPct ?? ev.peakPct) : ev.peakPct;
          if (!evts.some((ev) => { const v = valFn(ev); return v >= targetNet || v <= -targetNet; })) return false;
        }
        return true;
      });
      const result = filtered.sort((a, b) =>
        (crossoversData[oKey(b)]?.count ?? 0) - (crossoversData[oKey(a)]?.count ?? 0)
      );
      stableOrderRef.current = result.map(oKey);
      lastSortKeyRef.current = sortKey;
      return result;
    }

    const liveMap = new Map(spotOpportunities.map((o) => [oKey(o), o]));
    return stableOrderRef.current
      .map((k) => liveMap.get(k) ?? lastKnownRef.current.get(k))
      .filter(Boolean);
  }, [spotOpportunities, exchA, exchB, minPeak, maxMoveParsed, movTimeline,
      peakFilter, peakMode, targetNet, priceMovements, crossoversData]);


  const commitTarget = () => {
    const v = parseFloat(targetInput);
    setTargetNet(isFinite(v) ? v : 0);
  };

  return (
    <div className="flex flex-col gap-2 p-3 h-full overflow-auto">

      {/* Injected styles for TRADE button animation */}
      <style>{TRADE_BTN_STYLES}</style>

      {/* Trade modal */}
      {tradeOpp && (
        <TradeModal opp={tradeOpp} liveOpps={spotOpportunities} onClose={() => setTradeOpp(null)} />
      )}

      {/* Chart overlay modal */}
      {chartOpp && (
        <ChartOverlayModal opp={chartOpp} onClose={() => setChartOpp(null)} />
      )}

      {/* ── Single filters card ── */}
      <div style={{
        background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)",
        borderRadius: 12, padding: "8px 12px",
        display: "flex", flexDirection: "column", gap: 6,
      }}>

        {/* Row 1: Exchange + Min Peak + pair count */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
          <span style={lblStyle}>Buy</span>
          <select value={exchA} onChange={(e) => setExchA(e.target.value)} style={selStyle}>
            <option value="any">Any</option>
            {EXCHANGES.map((ex) => <option key={ex} value={ex}>{exLabel(ex)}</option>)}
          </select>
          <span style={lblStyle}>Sell</span>
          <select value={exchB} onChange={(e) => setExchB(e.target.value)} style={selStyle}>
            <option value="any">Any</option>
            {EXCHANGES.map((ex) => <option key={ex} value={ex}>{exLabel(ex)}</option>)}
          </select>
          <span style={dividerStyle} />
          <span style={lblStyle}>Min Peak</span>
          <input type="number" value={minPeak}
            onChange={(e) => setMinPeak(parseFloat(e.target.value) || 0)}
            style={{ ...selStyle, width: 52, textAlign: "right" }} step={0.05} min={0} />
          <span style={{ ...lblStyle, textTransform: "none", letterSpacing: 0 }}>%</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: "monospace", fontSize: 10, color: "var(--app-text-muted)" }}>
            {sorted.length} pairs
          </span>
        </div>

        {/* Separator */}
        <div style={{ height: 1, background: "var(--app-border-0)", margin: "0 -4px" }} />

        {/* Row 2: Max Price Move + Peak Chips + Peak Filter + Target Net % */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>

          <span style={lblStyle}>Max Move</span>
          <select value={movTimeline} onChange={(e) => setMovTimeline(e.target.value)} style={selStyle}>
            <option value="any">All TL</option>
            {TIMELINES.map((tl) => <option key={tl} value={tl}>{tl}</option>)}
          </select>
          <input type="number" placeholder="—" value={maxMove}
            onChange={(e) => setMaxMove(e.target.value)}
            style={{ ...selStyle, width: 56, textAlign: "right" }} step={0.5} min={0} />
          <span style={{ ...lblStyle, textTransform: "none", letterSpacing: 0 }}>%</span>
          {maxMove !== "" && (
            <button onClick={() => setMaxMove("")} style={{
              ...btnBase, color: "#f87171", border: "1px solid rgba(248,113,113,0.3)",
              background: "rgba(248,113,113,0.08)", padding: "1px 7px", fontSize: 10,
            }}>✕</button>
          )}

          <span style={dividerStyle} />

          <span style={lblStyle}>Peak Chips</span>
          <div style={{ display: "flex", alignItems: "center", borderRadius: 7, overflow: "hidden", border: "1px solid var(--app-border-1)" }}>
            {[{ k: "spread", label: "Spread" }, { k: "net", label: "Net %" }].map(({ k, label }) => {
              const active = peakMode === k;
              return (
                <button key={k} onClick={() => { setPeakMode(k); if (k !== "net") setPeakFilter(false); }}
                  style={{
                    padding: "2px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer",
                    background: active ? "var(--app-success-soft, rgba(34,197,94,0.12))" : "var(--app-surface-2)",
                    color:      active ? "var(--app-success, #4ade80)"                   : "var(--app-text-muted)",
                    borderRight: k === "spread" ? "1px solid var(--app-border-1)" : "none",
                    transition: "all 0.1s",
                  }}>
                  {label}
                </button>
              );
            })}
          </div>

          <span style={dividerStyle} />

          <span style={lblStyle}>Peak Filter</span>
          <button
            onClick={() => peakMode === "net" && setPeakFilter((v) => !v)}
            style={{
              ...btnBase, padding: "2px 10px",
              display: "flex", alignItems: "center", gap: 5,
              opacity: peakMode !== "net" ? 0.4 : 1,
              cursor: peakMode !== "net" ? "default" : "pointer",
              background: peakFilter && peakMode === "net" ? "var(--app-success-soft, rgba(34,197,94,0.12))" : "var(--app-surface-2)",
              color:      peakFilter && peakMode === "net" ? "var(--app-success, #4ade80)"                   : "var(--app-text-muted)",
              border:     `1px solid ${peakFilter && peakMode === "net" ? "var(--app-success-border, rgba(34,197,94,0.4))" : "var(--app-border-1)"}`,
            }}>
            <span style={{
              display: "inline-block", width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
              background: peakFilter && peakMode === "net" ? "var(--app-success, #4ade80)" : "var(--app-text-dimmer, #475569)",
            }} />
            Target % Chips
          </button>

          <span style={dividerStyle} />

          <span style={lblStyle}>Target Net %</span>
          <div style={{
            display: "flex", alignItems: "center", height: 22, borderRadius: 7, overflow: "hidden",
            background: "var(--app-surface-2)",
            border: "1px solid var(--app-success-border, rgba(34,197,94,0.4))",
          }}>
            <input
              type="number" step="0.1" value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              onBlur={commitTarget}
              onKeyDown={(e) => { if (e.key === "Enter") commitTarget(); }}
              style={{
                width: 44, background: "transparent", outline: "none", border: "none",
                textAlign: "center", fontFamily: "monospace", fontWeight: 700, fontSize: 11,
                color: "var(--app-success, #4ade80)", padding: "0 2px",
              }}
            />
            <span style={{
              padding: "0 5px", fontSize: 9, fontWeight: 700, borderLeft: "1px solid var(--app-border-1)",
              color: "var(--app-text-dimmer, #475569)", background: "var(--app-surface-1)",
              height: "100%", display: "flex", alignItems: "center",
            }}>%</span>
          </div>

          {peakFilter && peakMode === "net" && (
            <span style={{ fontSize: 9, color: "var(--app-text-dimmer, #475569)", fontFamily: "monospace" }}>
              chips ≥ +{targetNet.toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      <div className="rounded-xl overflow-hidden flex-1 min-h-0"
        style={{ border: "1px solid var(--app-border-0)" }}>

        {/* Header */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "200px 96px 96px 64px 1fr 190px 100px 88px",
          background: "var(--app-surface-1)",
          borderBottom: "1px solid var(--app-border-0)",
          padding: "7px 16px",
        }}>
          <span style={hdrCell}>Pair / Route</span>
          <span style={{ ...hdrCell, textAlign: "right" }}>Peak Profit</span>
          <span style={{ ...hdrCell, textAlign: "right" }}>Peak Low</span>
          <span style={{ ...hdrCell, textAlign: "center" }}>Count</span>
          <span style={{ ...hdrCell, paddingLeft: 10 }}>
            {peakMode === "net" ? "Net %" : "Spread %"} Crossover Chips
            {peakFilter && <span style={{ color: "var(--app-success, #4ade80)", marginLeft: 4 }}>· ≥{targetNet.toFixed(2)}%</span>}
          </span>
          <span style={{ ...hdrCell, textAlign: "right" }}>4H · 8H · 12H · 24H</span>
          <span style={{ ...hdrCell, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
            <Brain size={9} style={{ color: "var(--app-text-muted)" }} />
            AI SCORE
            {aiScoresFetching && <RefreshCw size={8} style={{ animation: "spin 1s linear infinite", marginLeft: 2 }} />}
          </span>
          <span style={{ ...hdrCell, textAlign: "center" }}>Action</span>
        </div>

        <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 400px)" }}>
          {sorted.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
              padding: "64px 0", color: "var(--app-text-muted)", fontSize: 12 }}>
              No potential opportunities match the filters
            </div>
          ) : sorted.map((opp) => {
            const key    = `${opp.symbol}|${opp.buyExchange}|${opp.sellExchange}`;
            const isOpen = expanded === key;
            const peak   = opp.highestNetProfitPct;
            const lowest = opp.lowestNetProfitPct;
            const cross  = crossoversData[key];
            const events = cross?.events ?? [];
            const mvs    = TIMELINES.map((tl) => priceMovements[opp.symbol]?.[tl]);

            const chipVal = (ev) => peakMode === "spread"
              ? (ev.peakSpreadPct ?? ev.peakPct)
              : ev.peakPct;

            const chron = [...events].reverse();

            let visibleChips;
            if (!peakFilter || chron.length === 0) {
              visibleChips = [...chron].reverse().map((ev, i) => ({
                ...ev, chunkIdx: i + 1, timeBetween: null, belowTarget: false,
              }));
            } else {
              const qualifying = chron.filter((ev) => {
                const v = chipVal(ev);
                return v >= targetNet || v <= -targetNet;
              });
              if (qualifying.length === 0) {
                const anyPos = [...chron].filter((e) => chipVal(e) > 0).sort((a, b) => chipVal(b) - chipVal(a))[0];
                const anyNeg = [...chron].filter((e) => chipVal(e) < 0).sort((a, b) => chipVal(a) - chipVal(b))[0];
                visibleChips = [anyPos, anyNeg].filter(Boolean).map((ev, i) => ({
                  ...ev, chunkIdx: i + 1, timeBetween: null, belowTarget: true,
                }));
              } else {
                const alternating = [];
                for (const ev of qualifying) {
                  const isPos = chipVal(ev) > 0;
                  if (alternating.length === 0) {
                    alternating.push(ev);
                  } else {
                    const lastPos = chipVal(alternating[alternating.length - 1]) > 0;
                    if (isPos !== lastPos) alternating.push(ev);
                  }
                }
                const tagged = alternating.map((ev, i) => {
                  const prevTs = i > 0 ? alternating[i - 1].ts : null;
                  const timeBetween = prevTs != null && ev.ts != null ? ev.ts - prevTs : null;
                  return { ...ev, chunkIdx: i + 1, timeBetween, belowTarget: false };
                });
                visibleChips = [...tagged].reverse();
              }
            }

            const hitCount = chron.filter((ev) => chipVal(ev) >= targetNet).length;

            const tokenKey = opp.symbol.replace("/USDT", "").toUpperCase();
            const aiScore  = aiScoresRaw[tokenKey] ?? null;

            return (
              <div key={key}>
                {/* Main row */}
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "200px 96px 96px 64px 1fr 190px 100px 88px",
                  alignItems: "center",
                  borderBottom: "1px solid var(--app-border-0)",
                  padding: "9px 16px",
                  cursor: "pointer",
                  background: isOpen ? "rgba(99,102,241,0.07)" : undefined,
                  transition: "background 0.12s",
                  minHeight: 54,
                }}
                  onClick={() => setExpanded(isOpen ? null : key)}
                  onMouseEnter={(e) => { if (!isOpen) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                  onMouseLeave={(e) => { if (!isOpen) e.currentTarget.style.background = ""; }}
                >
                  {/* Pair / Route */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                        <ExchangeIcon name={opp.buyExchange} size={16} />
                        <ArrowRight size={10} style={{ color: "var(--app-text-muted)" }} />
                        <ExchangeIcon name={opp.sellExchange} size={16} />
                      </div>
                      {isOpen
                        ? <ChevronUp   size={11} style={{ color: "var(--app-text-muted)", flexShrink: 0 }} />
                        : <ChevronDown size={11} style={{ color: "var(--app-text-muted)", flexShrink: 0 }} />}
                    </div>
                    <span style={{ fontWeight: 800, fontSize: 14, color: "var(--app-text-bright)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1 }}>
                      {opp.symbol}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--app-text-muted)", lineHeight: 1 }}>
                      {exLabel(opp.buyExchange)} → {exLabel(opp.sellExchange)}
                    </span>
                  </div>

                  {/* Peak Profit */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, fontFamily: "monospace", color: "#4ade80", lineHeight: 1 }}>
                      {fmtPct(peak)}
                    </span>
                    <span style={{ fontSize: 9, color: "var(--app-text-muted)", lineHeight: 1 }}>best peak</span>
                  </div>

                  {/* Peak Lowest */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", lineHeight: 1,
                      color: lowest != null && lowest >= 0 ? "#4ade80" : "#f87171" }}>
                      {fmtPct(lowest)}
                    </span>
                    <span style={{ fontSize: 9, color: "var(--app-text-muted)", lineHeight: 1 }}>worst</span>
                  </div>

                  {/* Count badge */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    {cross?.count > 0 ? (
                      <span style={{
                        background: "rgba(99,102,241,0.22)", border: "1px solid rgba(99,102,241,0.45)",
                        color: "#a5b4fc", borderRadius: 14, padding: "3px 10px",
                        fontSize: 12, fontWeight: 800, fontFamily: "monospace", lineHeight: 1,
                      }}>{cross.count}</span>
                    ) : (
                      <span style={{ fontSize: 12, color: "var(--app-text-muted)", fontFamily: "monospace" }}>—</span>
                    )}
                    {opp.profitTimesHit > 0 && (
                      <span style={{ fontSize: 9, color: "var(--app-text-muted)" }}>
                        {opp.profitTimesHit}× hit
                      </span>
                    )}
                  </div>

                  {/* Crossover Chips */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, paddingLeft: 10, paddingRight: 4, alignItems: "center" }}>
                    {peakFilter && chron.length > 0 && (
                      <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace",
                        color: "var(--app-text-muted)", marginRight: 3, flexShrink: 0 }}>
                        {hitCount}/{chron.filter(e => e.direction === "pos").length}
                      </span>
                    )}
                    {visibleChips.map((ev) => {
                      const val      = chipVal(ev);
                      const isPos    = ev.direction === "pos";
                      const dim      = ev.belowTarget;
                      const timeAgo  = fmtCrossTime(ev.ts);
                      const duration = fmtDuration(ev.timeBetween);
                      const bg     = dim ? "rgba(148,163,184,0.08)" : isPos ? "rgba(74,222,128,0.15)" : "rgba(248,113,113,0.12)";
                      const border = dim ? "rgba(148,163,184,0.2)"  : isPos ? "rgba(74,222,128,0.45)" : "rgba(248,113,113,0.4)";
                      const valColor = dim ? "var(--app-text-muted)" : isPos ? "#4ade80" : "#f87171";
                      return (
                        <div key={ev.chunkIdx}
                          title={`C${ev.chunkIdx} ${isPos ? "(+)" : "(-)"} | Peak: ${fmtPct(val, 3)} | Dur: ${durationLabel(ev.durationMs)}${ev.ts ? ` | ${new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`}
                          style={{
                            display: "flex", flexDirection: "column", alignItems: "center",
                            background: bg, border: `1px solid ${border}`,
                            borderRadius: 7, padding: "3px 8px", opacity: dim ? 0.5 : 1, flexShrink: 0,
                          }}>
                          <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: valColor, lineHeight: 1.2, whiteSpace: "nowrap" }}>
                            {val >= 0 ? "+" : ""}{val.toFixed(2)}%
                          </span>
                          <span style={{ fontSize: 8, fontWeight: 600, lineHeight: 1.2, marginTop: 1, color: "var(--app-text-muted)", whiteSpace: "nowrap" }}>
                            C{ev.chunkIdx}{duration ? ` · ${duration}` : (ev.chunkIdx === 1 && timeAgo ? ` · ${timeAgo}` : "")}
                          </span>
                        </div>
                      );
                    })}
                    {events.length === 0 && (
                      <span style={{ fontSize: 10, color: "var(--app-text-muted)", fontFamily: "monospace" }}>
                        no crossovers
                      </span>
                    )}
                  </div>

                  {/* Price Movements */}
                  <div style={{ display: "flex", gap: 14, justifyContent: "flex-end", alignItems: "center" }}>
                    {TIMELINES.map((tl, i) => {
                      const v = mvs[i];
                      const isSelected = movTimeline === tl;
                      return (
                        <span key={tl} style={{
                          fontSize: 12, fontFamily: "monospace", fontWeight: 700,
                          color: isSelected ? mvColor(v) ?? "var(--app-success, #4ade80)" : mvColor(v),
                          textDecoration: isSelected ? "underline" : "none",
                          textUnderlineOffset: 3,
                        }}>
                          {v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "—"}
                        </span>
                      );
                    })}
                  </div>

                  {/* AI Score */}
                  <div
                    style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
                    onClick={(e) => e.stopPropagation()}
                    title={aiScore != null
                      ? `AI Score: ${aiScore}/10 — ${aiScoreLabel(aiScore)}`
                      : "AI score not yet computed — will update every 60s"}
                  >
                    <AiScoreBadge score={aiScore} loading={false} />
                  </div>

                  {/* Action buttons */}
                  <div
                    style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, paddingLeft: 12 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button className="trade-btn" onClick={() => setTradeOpp(opp)}>
                      <Zap size={10} fill="currentColor" className="trade-icon" />
                      TRADE
                    </button>
                  </div>
                </div>

                {/* ── Expanded detail ── */}
                {isOpen && (
                  <div style={{
                    padding: "10px 16px",
                    background: "rgba(99,102,241,0.04)",
                    borderBottom: "1px solid var(--app-border-0)",
                    display: "flex", flexWrap: "wrap", gap: 16,
                  }}>
                    {[
                      { label: "Buy Exchange",  value: exLabel(opp.buyExchange),  color: exColor(opp.buyExchange)  },
                      { label: "Sell Exchange", value: exLabel(opp.sellExchange), color: exColor(opp.sellExchange) },
                      { label: "Buy Ask",  value: opp.buyAsk  != null ? `$${opp.buyAsk}`  : "—" },
                      { label: "Sell Bid", value: opp.sellBid != null ? `$${opp.sellBid}` : "—" },
                      { label: "Buy Fee",  value: opp.fees?.buyFeeRate  != null ? `${(opp.fees.buyFeeRate  * 100).toFixed(3)}%` : "—" },
                      { label: "Sell Fee", value: opp.fees?.sellFeeRate != null ? `${(opp.fees.sellFeeRate * 100).toFixed(3)}%` : "—" },
                      { label: "TDS",      value: opp.fees?.tdsRate     != null ? `${(opp.fees.tdsRate     * 100).toFixed(2)}%` : "—" },
                      { label: "Xfer Fee", value: opp.fees?.withdrawFeeUSD != null ? `$${opp.fees.withdrawFeeUSD.toFixed(4)}` : "—" },
                      { label: "Network",  value: opp.fees?.withdrawNetwork ?? "—" },

                    ].map(({ label, value, color }) => (
                      <div key={label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase",
                          letterSpacing: "0.06em", color: "var(--app-text-muted)" }}>{label}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace",
                          color: color ?? "var(--app-text-primary)" }}>{value}</span>
                      </div>
                    ))}
                    {/* AI Score Detail (expanded) */}
                    {aiScore != null && (() => {
                      const { bg, border, text } = aiScoreColor(aiScore);
                      const label = aiScoreLabel(aiScore);
                      return (
                        <div style={{
                          display: "flex", flexDirection: "column", gap: 4,
                          background: bg, border: `1px solid ${border}`,
                          borderRadius: 10, padding: "8px 12px", minWidth: 130,
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <Brain size={11} style={{ color: text }} />
                            <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase",
                              letterSpacing: "0.06em", color: text }}>AI SCORE</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                            <span style={{ fontSize: 22, fontWeight: 900, fontFamily: "monospace", color: text, lineHeight: 1 }}>
                              {aiScore}
                            </span>
                            <span style={{ fontSize: 10, color: text, opacity: 0.6 }}>/10</span>
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, color: text }}>{label}</span>
                          <span style={{ fontSize: 9, color: "var(--app-text-muted)" }}>Updated every 60s</span>
                        </div>
                      );
                    })()}

                    {/* Chart button */}
                    <button
                      onClick={(e) => { e.stopPropagation(); setChartOpp(opp); }}
                      title="View Spread & Price Charts"
                      style={{
                        display: "flex", alignItems: "center", gap: 5,
                        padding: "4px 10px", borderRadius: 7, cursor: "pointer",
                        background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.3)",
                        color: "#a5b4fc", fontSize: 10, fontWeight: 700,
                        transition: "all 0.13s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "rgba(99,102,241,0.2)";
                        e.currentTarget.style.borderColor = "rgba(99,102,241,0.5)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "rgba(99,102,241,0.1)";
                        e.currentTarget.style.borderColor = "rgba(99,102,241,0.3)";
                      }}
                    >
                      <BarChart2 size={11} />
                      View Charts
                    </button>

                    {cross?.events?.length > 0 && (
                      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase",
                          letterSpacing: "0.06em", color: "var(--app-text-muted)" }}>
                          Recent Crossovers ({cross.count} total)
                        </span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {cross.events.map((ev, i) => {
                            const val = chipVal(ev);
                            return (
                              <div key={i} style={{
                                display: "flex", alignItems: "center", gap: 5,
                                background: val >= targetNet ? "rgba(74,222,128,0.10)" : "rgba(148,163,184,0.06)",
                                border: `1px solid ${val >= targetNet ? "rgba(74,222,128,0.3)" : "rgba(148,163,184,0.15)"}`,
                                borderRadius: 8, padding: "3px 9px",
                              }}>
                                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace",
                                  color: val >= targetNet ? "#4ade80" : "var(--app-text-muted)" }}>
                                  {val >= 0 ? "+" : ""}{val.toFixed(3)}%
                                </span>
                                {peakMode === "spread" && ev.peakPct !== val && (
                                  <span style={{ fontSize: 9, fontFamily: "monospace", color: "var(--app-text-muted)" }}>
                                    net:{ev.peakPct >= 0 ? "+" : ""}{ev.peakPct.toFixed(2)}%
                                  </span>
                                )}
                                <span style={{ fontSize: 9, color: "var(--app-text-muted)", fontFamily: "monospace" }}>
                                  {durationLabel(ev.durationMs)}
                                </span>
                                <span style={{ fontSize: 9, color: "var(--app-text-muted)" }}>
                                  {new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
