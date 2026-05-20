import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExchangeIcon } from "./ExchangeIcon";
import {
  TrendingUp, TrendingDown, BarChart2, CheckCircle2, XCircle,
  AlertTriangle, Activity, ArrowRight, Clock, Network, Hash,
  DollarSign, ChevronDown, ChevronUp, RefreshCw, Layers,
  Calendar, X,
  ShoppingCart, Send, Download, Eye, BadgeDollarSign, Camera,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAge(ms) {
  if (ms < 0) ms = 0;
  if (ms < 60_000)    return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtPrice(v) {
  if (v == null) return "—";
  if (v >= 1000)  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (v >= 1)     return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

function fmtQty(v, sym) {
  if (v == null) return "—";
  const s = v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6);
  return sym ? `${s} ${sym}` : s;
}

function pctColor(v) {
  if (v == null) return "var(--app-text-muted)";
  return v >= 0 ? "var(--app-success)" : "var(--app-danger)";
}

function pctStr(v, decimals = 3) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}%`;
}

function phaseColor(p) {
  if (p === "completed")            return "var(--app-success)";
  if (p === "failed")               return "var(--app-danger)";
  if (p === "monitoring")           return "#60a5fa";
  if (p === "waiting_deposit")      return "var(--app-warning)";
  if (p === "waiting_withdrawal")   return "#fb923c";
  if (p === "selling")              return "#a78bfa";
  if (p === "transferring")         return "#fb923c";
  return "var(--app-text-muted)";
}
function phaseBg(p) {
  if (p === "completed")            return "var(--app-success-soft)";
  if (p === "failed")               return "var(--app-danger-soft)";
  if (p === "monitoring")           return "rgba(96,165,250,0.12)";
  if (p === "waiting_deposit")      return "var(--app-warning-soft)";
  if (p === "waiting_withdrawal")   return "rgba(251,146,60,0.12)";
  if (p === "selling")              return "rgba(167,139,250,0.12)";
  if (p === "transferring")         return "rgba(251,146,60,0.12)";
  return "var(--app-surface-2)";
}
function phaseLabel(p) {
  return ({
    buying:             "BUY",
    transferring:       "TRANSFER",
    waiting_withdrawal: "WITHDRAWAL",
    waiting_deposit:    "DEPOSIT",
    monitoring:         "MONITOR",
    selling:            "SELL",
    completed:          "DONE",
    failed:             "FAILED",
  })[p] ?? (p?.toUpperCase() ?? "?");
}

const PHASE_STEPS = ["buying", "transferring", "waiting_withdrawal", "waiting_deposit", "monitoring", "selling"];

const EX_COLORS = {
  binance: "#F0B90B",
  bybit:   "#F7A600",
  kucoin:  "#24ae8f",
  bitget:  "#00B897",
};

// ── Sub-components ────────────────────────────────────────────────────────────

const EX_INITIALS = {
  binance: "BN",
  bybit:   "BB",
  kucoin:  "KC",
  bitget:  "BG",
};

// Exchange logo — CDN image (falls back to brand circle via ExchangeIcon)
function ExLogo({ exchange, size = 24 }) {
  return <ExchangeIcon name={exchange} size={size} />;
}

function ExBadge({ name }) {
  const col = EX_COLORS[name] ?? "var(--app-text-muted)";
  return (
    <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full"
      style={{ background: col + "22", color: col, border: `1px solid ${col}55` }}>
      {name}
    </span>
  );
}

function PhaseChip({ phase }) {
  const col = phaseColor(phase);
  const bg  = phaseBg(phase);
  return (
    <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full"
      style={{ background: bg, color: col, border: `1px solid ${col}55` }}>
      {phaseLabel(phase)}
    </span>
  );
}

function InfoRow({ label, value, valueColor, mono = true }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[9px] uppercase tracking-widest flex-shrink-0"
        style={{ color: "var(--app-text-dimmer)" }}>{label}</span>
      <span className={`text-[10px] font-bold ${mono ? "font-mono" : ""} text-right`}
        style={{ color: valueColor ?? "var(--app-text-muted)" }}>
        {value}
      </span>
    </div>
  );
}

// Row inside the new buy/sell detail cards
// showDash=true: renders even when value is null/empty, showing "—" placeholder
function TxRow({ label, value, accent = false, mono = false, truncate = false, small = false, showDash = false }) {
  const isEmpty = value == null || value === "" || value === "—";
  if (isEmpty && !showDash) return null;
  const displayVal = isEmpty
    ? "—"
    : truncate && typeof value === "string" && value.length > 16
      ? `${value.slice(0, 14)}…`
      : value;
  return (
    <div className="flex items-center justify-between gap-1 px-2.5 py-1.5">
      <span className="text-[8px] uppercase tracking-widest flex-shrink-0"
        style={{ color: "var(--app-text-dimmer)" }}>
        {label}
      </span>
      <span
        className={[
          mono ? "font-mono" : "font-bold",
          small ? "text-[8px]" : "text-[9px]",
          truncate ? "text-right" : "text-right font-bold",
        ].join(" ")}
        style={{ color: isEmpty ? "var(--app-text-dimmer)" : accent ? "var(--app-text-bright)" : "var(--app-text-muted)" }}
        title={typeof value === "string" ? value : undefined}>
        {displayVal}
      </span>
    </div>
  );
}

// ── Phase timeline ─────────────────────────────────────────────────────────────

const PHASE_STEPS_META = [
  { key: "buying",              short: "Buy",      Icon: ShoppingCart    },
  { key: "transferring",        short: "Xfer",     Icon: Send            },
  { key: "waiting_withdrawal",  short: "W.Draw",   Icon: Clock           },
  { key: "waiting_deposit",     short: "Deposit",  Icon: Download        },
  { key: "monitoring",          short: "Monitor",  Icon: Eye             },
  { key: "selling",             short: "Sell",     Icon: BadgeDollarSign },
];

function PhaseTimeline({ phase }) {
  const isFailed = phase === "failed";
  const isDone   = phase === "completed";
  const phaseIdx = PHASE_STEPS.indexOf(phase);

  return (
    <div className="flex items-start w-full">
      {PHASE_STEPS_META.map(({ key, short, Icon }, i) => {
        const done   = !isFailed && (isDone || phaseIdx > i);
        const active = !isDone && !isFailed && phase === key;
        const fail   = isFailed && phase === key;

        const col = fail   ? "var(--app-danger)"
          : done    ? "var(--app-success)"
          : active  ? "#60a5fa"
          : "var(--app-border-1)";

        const bgCol = done   ? "var(--app-success-soft)"
          : active  ? "rgba(96,165,250,0.14)"
          : fail    ? "var(--app-danger-soft)"
          : "var(--app-surface-2)";

        return (
          <div key={key} className="flex items-start"
            style={{ flex: i < PHASE_STEPS_META.length - 1 ? "1 1 0%" : "0 0 auto" }}>

            <div className="flex flex-col items-center gap-1 flex-shrink-0">
              {/* Circle */}
              <div className="flex items-center justify-center rounded-full relative"
                style={{
                  width: 28, height: 28,
                  border: `2px solid ${col}`,
                  background: bgCol,
                  boxShadow: active ? `0 0 0 3px ${col}22` : "none",
                  transition: "all 0.2s",
                }}>
                {done && (
                  <CheckCircle2 style={{ width: 12, height: 12, color: col }} />
                )}
                {active && (
                  <Icon style={{ width: 11, height: 11, color: col, animation: "pulse 1.5s ease-in-out infinite" }} />
                )}
                {fail && (
                  <AlertTriangle style={{ width: 11, height: 11, color: col }} />
                )}
                {!done && !active && !fail && (
                  <Icon style={{ width: 11, height: 11, color: col, opacity: 0.45 }} />
                )}
              </div>

              {/* Label */}
              <span className="text-[7px] font-extrabold uppercase tracking-widest text-center"
                style={{ color: col, lineHeight: 1, letterSpacing: "0.06em" }}>
                {short}
              </span>
            </div>

            {/* Connector line */}
            {i < PHASE_STEPS_META.length - 1 && (
              <div style={{
                flex: 1,
                height: 2,
                marginTop: 13,
                marginLeft: 3,
                marginRight: 3,
                background: (!isFailed && (isDone || phaseIdx > i))
                  ? "var(--app-success)"
                  : "var(--app-border-1)",
                borderRadius: 2,
                transition: "background 0.3s",
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Active Trade Full Card ─────────────────────────────────────────────────────

function ActiveTradeFullCard({ trade, now }) {
  const phase    = trade.phase;
  const isFailed = phase === "failed";
  const isDone   = phase === "completed";
  const elapsed  = now - trade.timestamp;
  const tradeDuration = trade.completedAt ? trade.completedAt - trade.timestamp : elapsed;
  const monAge   = trade.monitoringStartAt ? now - trade.monitoringStartAt : 0;

  const accentCol = isFailed ? "var(--app-danger)"
    : isDone        ? "var(--app-success)"
    : phase === "monitoring" ? "#60a5fa"
    : phase === "waiting_deposit" ? "var(--app-warning)"
    : "var(--app-text-muted)";

  const finalPct   = trade.actualNetProfitPct ?? trade.currentNetProfitPct ?? trade.expectedNetProfitPct;
  const profitUSDT = trade.actualNetProfitPct != null
    ? (trade.tradeAmountUSDT ?? 0) * trade.actualNetProfitPct / 100 : null;

  const makerFeeUSDT = trade.makerFee != null && trade.tradeAmountUSDT != null
    ? (trade.makerFee * trade.tradeAmountUSDT).toFixed(4) : null;
  const takerFeeUSDT = trade.takerFee != null && trade.executedSellPrice != null && trade.executedSellQty != null
    ? (trade.takerFee * trade.executedSellPrice * trade.executedSellQty).toFixed(4) : null;
  const currentSpreadPct = trade.currentBid != null && trade.executedBuyPrice != null
    ? ((trade.currentBid - trade.executedBuyPrice) / trade.executedBuyPrice) * 100 : null;

  const cycleRows = [
    trade.withdrawalInitiatedAt
      ? { label: "BUY", dur: trade.withdrawalInitiatedAt - trade.timestamp } : null,
    trade.withdrawalInitiatedAt && trade.monitoringStartAt
      ? { label: "XFER + DEP", dur: trade.monitoringStartAt - trade.withdrawalInitiatedAt } : null,
    trade.monitoringStartAt && trade.completedAt
      ? { label: "MONITOR", dur: trade.completedAt - trade.monitoringStartAt } : null,
  ].filter(Boolean);

  const hasTransfer = !!(trade.transferNetwork || trade.withdrawalId || trade.depositedQty != null || trade.depositAddress);
  const isLive = phase === "monitoring" || phase === "selling";

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ border: `1px solid ${accentCol}55`, boxShadow: `0 0 0 1px ${accentCol}18` }}>

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-3"
        style={{ background: accentCol + "18", borderBottom: `1px solid ${accentCol}33` }}>
        <div className="flex items-center gap-2">
          {isDone
            ? <CheckCircle2 style={{ width: 14, height: 14, color: accentCol }} />
            : isFailed
            ? <XCircle style={{ width: 14, height: 14, color: accentCol }} />
            : <Activity style={{ width: 14, height: 14, color: accentCol, animation: "spin 2s linear infinite" }} />
          }
          <span className="text-[11px] font-extrabold uppercase tracking-widest" style={{ color: accentCol }}>
            {isDone ? "Completed Trade" : isFailed ? "Failed Trade" : "Active Trade"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-extrabold font-mono tracking-tight" style={{ color: "var(--app-text-bright)" }}>
            {trade.symbol}
          </span>
          <PhaseChip phase={phase} />
          <span className="text-[9px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
            {fmtDuration(tradeDuration)}
          </span>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-4" style={{ background: "var(--app-surface-1)" }}>

        {/* Route */}
        <div className="flex items-center gap-1.5">
          <ExLogo exchange={trade.buyExchange} size={16} />
          <ExBadge name={trade.buyExchange} />
          <ArrowRight style={{ width: 10, height: 10, color: "var(--app-text-dimmer)" }} />
          <ExLogo exchange={trade.sellExchange} size={16} />
          <ExBadge name={trade.sellExchange} />
        </div>

        {/* Phase timeline */}
        <PhaseTimeline phase={phase} />

        {/* ── P&L highlight ── */}
        {finalPct != null && (
          <div className="flex items-center justify-between rounded-xl px-4 py-3"
            style={{ background: (finalPct >= 0 ? "var(--app-success)" : "var(--app-danger)") + "18",
              border: `1px solid ${finalPct >= 0 ? "var(--app-success)" : "var(--app-danger)"}44` }}>
            <div className="flex flex-col gap-0.5">
              <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                {isDone ? "Actual Net P&L" : "Live Net Profit"}
              </span>
              <span className="text-2xl font-extrabold font-mono"
                style={{ color: finalPct >= 0 ? "var(--app-success)" : "var(--app-danger)" }}>
                {pctStr(finalPct, 3)}
              </span>
            </div>
            {profitUSDT != null && (
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>P&L (USDT)</span>
                <span className="text-xl font-extrabold font-mono"
                  style={{ color: profitUSDT >= 0 ? "var(--app-success)" : "var(--app-danger)" }}>
                  {profitUSDT >= 0 ? "+" : ""}${profitUSDT.toFixed(4)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── Buy / Sell cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {/* BUY */}
          <div className="flex flex-col gap-0 rounded-xl overflow-hidden"
            style={{ border: "1px solid var(--app-success-border)" }}>
            <div className="flex items-center gap-2 px-2.5 py-2"
              style={{ background: "var(--app-success-soft)", borderBottom: "1px solid var(--app-success-border)" }}>
              <ExLogo exchange={trade.buyExchange} size={20} />
              <div className="flex flex-col leading-none">
                <span className="text-[8px] font-extrabold uppercase tracking-widest" style={{ color: "var(--app-success)" }}>BUY</span>
                <span className="text-[9px] font-bold capitalize" style={{ color: "var(--app-text-muted)" }}>{trade.buyExchange}</span>
              </div>
            </div>
            <div className="flex flex-col gap-0 divide-y"
              style={{ background: "var(--app-surface-1)", borderColor: "var(--app-border-0)" }}>
              <TxRow label="Amount"    value={trade.tradeAmountUSDT != null ? `$${trade.tradeAmountUSDT}` : null} accent />
              <TxRow label="Price"     value={fmtPrice(trade.executedBuyPrice)} />
              <TxRow label="Quantity"  value={fmtQty(trade.executedBuyQty, trade.symbol)} />
              <TxRow label="Maker Fee" value={makerFeeUSDT != null ? `$${makerFeeUSDT}` : null} />
              <TxRow label="Order ID"  value={trade.buyOrderId} mono truncate />
              <TxRow label="Time"      value={trade.timestamp ? new Date(trade.timestamp).toLocaleString() : null} mono small />
            </div>
          </div>

          {/* SELL */}
          {(() => {
            const sellDone = trade.executedSellPrice != null;
            return (
              <div className="flex flex-col gap-0 rounded-xl overflow-hidden"
                style={{ border: "1px solid var(--app-danger-border)" }}>
                <div className="flex items-center gap-2 px-2.5 py-2"
                  style={{ background: "var(--app-danger-soft)", borderBottom: "1px solid var(--app-danger-border)" }}>
                  <ExLogo exchange={trade.sellExchange} size={20} />
                  <div className="flex flex-col leading-none">
                    <span className="text-[8px] font-extrabold uppercase tracking-widest" style={{ color: "var(--app-danger)" }}>SELL</span>
                    <span className="text-[9px] font-bold capitalize" style={{ color: "var(--app-text-muted)" }}>{trade.sellExchange}</span>
                  </div>
                  {!sellDone && (
                    <span className="ml-auto text-[7px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full"
                      style={{ background: "rgba(251,146,60,0.15)", color: "#fb923c", border: "1px solid rgba(251,146,60,0.35)" }}>
                      Pending
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-0 divide-y"
                  style={{ background: "var(--app-surface-1)", borderColor: "var(--app-border-0)" }}>
                  <TxRow label="Price"     value={fmtPrice(trade.executedSellPrice)}   showDash />
                  <TxRow label="Quantity"  value={fmtQty(trade.executedSellQty, trade.symbol)} showDash />
                  <TxRow label="Taker Fee" value={takerFeeUSDT != null ? `$${takerFeeUSDT}` : null} showDash />
                  <TxRow label="1% TDS"    value={trade.executedSellPrice != null && trade.executedSellQty != null
                    ? `$${(trade.executedSellPrice * trade.executedSellQty * 0.01).toFixed(4)}` : null} accent showDash />
                  <TxRow label="Order ID"  value={trade.sellOrderId} mono truncate showDash />
                  <TxRow label="Time"      value={trade.completedAt ? new Date(trade.completedAt).toLocaleString() : null} mono small showDash />
                </div>
              </div>
            );
          })()}
        </div>

        {/* ── Live monitor section ── */}
        {isLive && trade.currentBid != null && (
          <div className="flex flex-col gap-2.5 rounded-xl px-3 py-3"
            style={{ background: "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.22)" }}>
            <div className="flex items-center gap-1.5">
              <Activity style={{ width: 9, height: 9, color: "#60a5fa" }} />
              <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "#60a5fa" }}>
                Live Monitor
              </span>
              <span className="ml-auto text-[8px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
                {fmtDuration(monAge)} elapsed
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "Net Profit",  val: pctStr(trade.currentNetProfitPct, 3), col: pctColor(trade.currentNetProfitPct) },
                { label: "Spread",      val: currentSpreadPct != null ? pctStr(currentSpreadPct, 3) : "—", col: currentSpreadPct != null ? pctColor(currentSpreadPct) : "var(--app-text-muted)" },
                { label: "Profit Hits", val: trade.timesHit != null ? `${trade.timesHit}×` : "—", col: "var(--app-text-bright)" },
              ].map(({ label, val, col }) => (
                <div key={label} className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5"
                  style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}>
                  <span className="text-[7px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>{label}</span>
                  <span className="text-[12px] font-extrabold font-mono" style={{ color: col }}>{val}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-[9px]">
              <span style={{ color: "var(--app-text-dimmer)" }}>Live Bid ({trade.sellExchange})</span>
              <span className="font-mono font-bold" style={{ color: "#60a5fa" }}>{fmtPrice(trade.currentBid)}</span>
            </div>
            <div className="flex items-center justify-between text-[9px]">
              <span style={{ color: "var(--app-text-dimmer)" }}>Target Profit</span>
              <span className="font-mono" style={{ color: "var(--app-text-muted)" }}>
                +{trade.expectedNetProfitPct?.toFixed(1) ?? "—"}%
              </span>
            </div>
          </div>
        )}

        {/* ── Entry Snapshot ── */}
        {trade.opportunitySnapshot && (() => {
          const snap = trade.opportunitySnapshot;
          const f    = snap.fees;
          const buyFeeEff  = f.buyFeeRate  * (1 + f.feeTaxRate);
          const sellFeeEff = f.sellFeeRate * (1 + f.feeTaxRate);
          const amt        = trade.tradeAmountUSDT ?? 1000;
          const tokens     = amt / snap.buyAsk;
          const sellValue  = tokens * snap.sellBid;
          const buyFeeUSD  = amt * buyFeeEff;
          const sellFeeUSD = sellValue * sellFeeEff;
          const tdsUSD     = sellValue * f.tdsRate;
          const wdFeeUSD   = f.withdrawFeeUSD ?? 0;

          return (
            <div className="flex flex-col gap-0 rounded-xl overflow-hidden"
              style={{ border: "1px solid rgba(168,85,247,0.35)" }}>

              {/* Header */}
              <div className="flex items-center gap-1.5 px-3 py-2"
                style={{ background: "rgba(168,85,247,0.12)", borderBottom: "1px solid rgba(168,85,247,0.2)" }}>
                <Camera style={{ width: 9, height: 9, color: "#a855f7" }} />
                <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "#a855f7" }}>
                  Entry Snapshot
                </span>
                <span className="ml-auto text-[7.5px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
                  {new Date(snap.capturedAt).toLocaleTimeString()}
                </span>
              </div>

              {/* Key metrics row */}
              <div className="grid grid-cols-3 gap-0 divide-x"
                style={{ borderBottom: "1px solid var(--app-border-0)", borderColor: "var(--app-border-0)" }}>
                {[
                  { label: "Net Profit",   val: `${snap.netProfitPct >= 0 ? "+" : ""}${snap.netProfitPct.toFixed(3)}%`,  col: snap.netProfitPct >= 0 ? "var(--app-success)" : "var(--app-danger)" },
                  { label: "Gross Spread", val: `+${snap.grossSpreadPct.toFixed(3)}%`,                                    col: "var(--app-text-bright)" },
                  { label: "Times Hit",    val: `${snap.timesHit}×`,                                                       col: snap.timesHit >= 3 ? "var(--app-success)" : "var(--app-warning)" },
                ].map(({ label, val, col }) => (
                  <div key={label} className="flex flex-col items-center gap-0.5 py-2 px-2"
                    style={{ background: "var(--app-surface-1)" }}>
                    <span className="text-[7px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>{label}</span>
                    <span className="text-[13px] font-extrabold font-mono" style={{ color: col }}>{val}</span>
                  </div>
                ))}
              </div>

              {/* Price row */}
              <div className="grid grid-cols-2 gap-0 divide-x"
                style={{ borderBottom: "1px solid var(--app-border-0)", borderColor: "var(--app-border-0)" }}>
                <div className="flex flex-col gap-0.5 py-2 px-3" style={{ background: "var(--app-surface-1)" }}>
                  <span className="text-[7px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                    Buy Ask ({trade.buyExchange})
                  </span>
                  <span className="text-[11px] font-extrabold font-mono" style={{ color: "var(--app-success)" }}>
                    {fmtPrice(snap.buyAsk)}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 py-2 px-3" style={{ background: "var(--app-surface-1)" }}>
                  <span className="text-[7px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                    Sell Bid ({trade.sellExchange})
                  </span>
                  <span className="text-[11px] font-extrabold font-mono" style={{ color: "var(--app-danger)" }}>
                    {fmtPrice(snap.sellBid)}
                  </span>
                </div>
              </div>

              {/* Fee breakdown */}
              <div className="flex flex-col gap-0 divide-y" style={{ background: "var(--app-surface-1)", borderColor: "var(--app-border-0)" }}>
                <div className="flex items-center justify-between px-3 py-1.5 text-[9px]">
                  <span style={{ color: "var(--app-text-dimmer)" }}>Buy Fee ({(buyFeeEff * 100).toFixed(3)}% eff.)</span>
                  <span className="font-mono" style={{ color: "var(--app-text-muted)" }}>
                    −${buyFeeUSD.toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-1.5 text-[9px]">
                  <span style={{ color: "var(--app-text-dimmer)" }}>Sell Fee ({(sellFeeEff * 100).toFixed(3)}% eff.)</span>
                  <span className="font-mono" style={{ color: "var(--app-text-muted)" }}>
                    −${sellFeeUSD.toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-1.5 text-[9px]">
                  <span style={{ color: "var(--app-text-dimmer)" }}>TDS ({(f.tdsRate * 100).toFixed(0)}% on sell)</span>
                  <span className="font-mono font-bold" style={{ color: "var(--app-warning)" }}>
                    −${tdsUSD.toFixed(4)}
                  </span>
                </div>
                {wdFeeUSD > 0 && (
                  <div className="flex items-center justify-between px-3 py-1.5 text-[9px]">
                    <span style={{ color: "var(--app-text-dimmer)" }}>
                      Withdrawal
                      {f.withdrawNetwork ? ` (${f.withdrawNetwork})` : ""}
                      {f.speedTier ? ` · ${f.speedTier}` : ""}
                      {f.feeSource ? ` · ${f.feeSource}` : ""}
                    </span>
                    <span className="font-mono" style={{ color: "var(--app-text-muted)" }}>
                      −${wdFeeUSD.toFixed(4)}
                    </span>
                  </div>
                )}
                {f.addressVerified != null && (
                  <div className="flex items-center justify-between px-3 py-1.5 text-[9px]">
                    <span style={{ color: "var(--app-text-dimmer)" }}>
                      Address verified{f.routesConsidered != null ? ` · ${f.routesConsidered} route${f.routesConsidered > 1 ? "s" : ""} checked` : ""}
                    </span>
                    <span className="font-mono font-bold" style={{ color: f.addressVerified ? "var(--app-success)" : "var(--app-warning)" }}>
                      {f.addressVerified ? "YES" : "NO (name match)"}
                    </span>
                  </div>
                )}
              </div>

              {/* All exchange prices at entry */}
              {snap.allPrices && snap.allPrices.length > 0 && (
                <div className="flex flex-col gap-0"
                  style={{ borderTop: "1px solid var(--app-border-0)" }}>
                  <div className="flex items-center gap-1.5 px-3 py-1.5"
                    style={{ background: "var(--app-surface-2)" }}>
                    <BarChart2 style={{ width: 8, height: 8, color: "var(--app-text-dimmer)" }} />
                    <span className="text-[7px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                      All Exchange Prices at Entry
                    </span>
                  </div>
                  <div className="flex flex-col gap-0 divide-y" style={{ background: "var(--app-surface-1)", borderColor: "var(--app-border-0)" }}>
                    {snap.allPrices.map((p) => (
                      <div key={p.exchange} className="flex items-center justify-between px-3 py-1 text-[9px]">
                        <div className="flex items-center gap-1.5">
                          <ExLogo exchange={p.exchange} size={11} />
                          <span className="capitalize font-bold" style={{ color: "var(--app-text-muted)" }}>{p.exchange}</span>
                          {p.exchange === trade.buyExchange && (
                            <span className="text-[6.5px] font-bold px-1 rounded"
                              style={{ background: "var(--app-success-soft)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}>BUY</span>
                          )}
                          {p.exchange === trade.sellExchange && (
                            <span className="text-[6.5px] font-bold px-1 rounded"
                              style={{ background: "var(--app-danger-soft)", color: "var(--app-danger)", border: "1px solid var(--app-danger-border)" }}>SELL</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 font-mono">
                          <span style={{ color: "var(--app-text-dimmer)" }}>
                            ask <span style={{ color: "var(--app-text-muted)" }}>{fmtPrice(p.ask)}</span>
                          </span>
                          <span style={{ color: "var(--app-text-dimmer)" }}>
                            bid <span style={{ color: "var(--app-text-muted)" }}>{fmtPrice(p.bid)}</span>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Highest net profit seen before trigger */}
              {snap.highestNetProfitPct != null && (
                <div className="flex items-center justify-between px-3 py-1.5 text-[9px]"
                  style={{ background: "var(--app-surface-2)", borderTop: "1px solid var(--app-border-0)" }}>
                  <span style={{ color: "var(--app-text-dimmer)" }}>Peak net profit seen (4H window)</span>
                  <span className="font-mono font-bold" style={{ color: "var(--app-success)" }}>
                    +{snap.highestNetProfitPct.toFixed(3)}%
                  </span>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Transfer Details ── */}
        {hasTransfer && (
          <div className="flex flex-col gap-0 rounded-xl overflow-hidden"
            style={{ border: "1px solid var(--app-border-1)" }}>
            <div className="flex items-center gap-1.5 px-3 py-2"
              style={{ background: "var(--app-surface-2)", borderBottom: "1px solid var(--app-border-0)" }}>
              <Network style={{ width: 9, height: 9, color: "var(--app-text-dimmer)" }} />
              <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                Transfer Details
              </span>
            </div>
            <div className="flex flex-col gap-0 divide-y"
              style={{ background: "var(--app-surface-1)", borderColor: "var(--app-border-0)" }}>
              <TxRow label="Network"
                value={trade.transferNetwork && trade.transferNetworkNative
                  ? `${trade.transferNetwork} (${trade.transferNetworkNative})` : trade.transferNetwork} />
              <TxRow label="Deposit Addr"  value={trade.depositAddress} mono truncate />
              <TxRow label="Wdrl ID"       value={trade.withdrawalId} mono truncate />
              <TxRow label="Wdrl Amount"   value={trade.executedBuyQty != null ? fmtQty(trade.executedBuyQty, trade.symbol) : null} />
              <TxRow label="Wdrl Fees"     value={trade.withdrawalFeeQty != null ? fmtQty(trade.withdrawalFeeQty, trade.symbol) : null} />
              <TxRow label="Wdrl Status"   value={trade.withdrawalStatus?.toUpperCase()}
                accent={trade.withdrawalStatus === "success"} />
              <TxRow label="Dep Status"
                value={trade.withdrawalTxId ? "CONFIRMED" : trade.depositedQty != null ? "RECEIVED" : null}
                accent={!!(trade.withdrawalTxId || trade.depositedQty != null)} />
              <TxRow label="Dep Amount"    value={fmtQty(trade.depositedQty, trade.symbol)} />
              <TxRow label="Dep Fees"
                value={trade.depositFeeQty != null
                  ? fmtQty(trade.depositFeeQty, trade.symbol)
                  : trade.executedBuyQty != null && trade.depositedQty != null
                    ? fmtQty(parseFloat((trade.executedBuyQty - trade.depositedQty).toFixed(6)), trade.symbol)
                    : null} />
            </div>
          </div>
        )}

        {/* ── Trade Cycle ── */}
        <div className="flex flex-col gap-2 rounded-xl px-3 py-2.5"
          style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)" }}>
          <div className="flex items-center gap-1.5">
            <Clock style={{ width: 9, height: 9, color: "var(--app-text-dimmer)" }} />
            <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
              Trade Cycle
            </span>
            <span className="ml-auto text-[9px] font-extrabold font-mono" style={{ color: "var(--app-text-muted)" }}>
              Total: {fmtDuration(tradeDuration)}
            </span>
          </div>
          {cycleRows.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {cycleRows.map(({ label, dur }) => (
                <div key={label} className="flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-lg flex-1"
                  style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)", minWidth: 64 }}>
                  <span className="text-[7px] font-bold uppercase tracking-widest text-center"
                    style={{ color: "var(--app-text-dimmer)" }}>{label}</span>
                  <span className="text-[11px] font-extrabold font-mono"
                    style={{ color: "var(--app-text-muted)" }}>{fmtDuration(dur)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between flex-wrap gap-1">
            {trade.timestamp && (
              <span className="text-[8px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
                Start: {new Date(trade.timestamp).toLocaleString()}
              </span>
            )}
            {trade.completedAt && (
              <span className="text-[8px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
                End: {new Date(trade.completedAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {/* Error */}
        {isFailed && trade.error && (
          <div className="flex items-start gap-2 rounded-lg px-3 py-2"
            style={{ background: "var(--app-danger-soft)", border: "1px solid var(--app-danger-border)" }}>
            <AlertTriangle style={{ width: 11, height: 11, color: "var(--app-danger)", flexShrink: 0, marginTop: 1 }} />
            <span className="text-[9px] break-all" style={{ color: "var(--app-danger)" }}>{trade.error}</span>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Compact History Card ───────────────────────────────────────────────────────

function TradeHistoryCard({ trade, now }) {
  const [expanded, setExpanded] = useState(false);
  const phase    = trade.phase;
  const isFailed = phase === "failed";
  const isDone   = phase === "completed";
  const elapsed  = now - trade.timestamp;
  const tradeDuration = trade.completedAt
    ? trade.completedAt - trade.timestamp
    : elapsed;

  const finalPct  = trade.actualNetProfitPct ?? trade.expectedNetProfitPct;
  const profitUSDT = trade.actualNetProfitPct != null
    ? (trade.tradeAmountUSDT ?? 0) * trade.actualNetProfitPct / 100
    : null;

  const accentCol = isFailed ? "var(--app-danger)" : isDone && finalPct >= 0 ? "var(--app-success)" : isDone ? "var(--app-danger)" : phaseColor(phase);

  return (
    <div className="rounded-xl overflow-hidden transition-all"
      style={{ border: `1px solid ${accentCol}44`, background: "var(--app-surface-1)" }}>

      {/* Collapsed summary row */}
      <button
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left"
        style={{ background: "transparent", cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}>

        {/* Left: symbol + route + phase */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="flex flex-col gap-0.5 flex-shrink-0" style={{ minWidth: 40 }}>
            <span className="text-xs font-extrabold font-mono" style={{ color: "var(--app-text-bright)" }}>
              {trade.symbol}
            </span>
          </div>
          <div className="flex items-center gap-1 min-w-0">
            <ExLogo exchange={trade.buyExchange} size={14} />
            <span className="text-[9px] font-bold" style={{ color: EX_COLORS[trade.buyExchange] ?? "var(--app-text-muted)" }}>
              {trade.buyExchange}
            </span>
            <ArrowRight style={{ width: 8, height: 8, color: "var(--app-text-dimmer)", flexShrink: 0 }} />
            <ExLogo exchange={trade.sellExchange} size={14} />
            <span className="text-[9px] font-bold" style={{ color: EX_COLORS[trade.sellExchange] ?? "var(--app-text-muted)" }}>
              {trade.sellExchange}
            </span>
          </div>
          <PhaseChip phase={phase} />
        </div>

        {/* Right: P&L + age + expand */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {finalPct != null && (
            <div className="flex flex-col items-end gap-0">
              <span className="text-[11px] font-extrabold font-mono"
                style={{ color: finalPct >= 0 ? "var(--app-success)" : "var(--app-danger)" }}>
                {pctStr(finalPct, 3)}
              </span>
              {profitUSDT != null && (
                <span className="text-[8px] font-mono"
                  style={{ color: profitUSDT >= 0 ? "var(--app-success)" : "var(--app-danger)" }}>
                  {profitUSDT >= 0 ? "+" : ""}${Math.abs(profitUSDT).toFixed(3)}
                </span>
              )}
            </div>
          )}
          <div className="flex flex-col items-end gap-0">
            <span className="text-[8px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
              {fmtDuration(tradeDuration)}
            </span>
            <span className="text-[7px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
              {fmtAge(elapsed)}
            </span>
          </div>
          {expanded
            ? <ChevronUp  style={{ width: 12, height: 12, color: "var(--app-text-dimmer)", flexShrink: 0 }} />
            : <ChevronDown style={{ width: 12, height: 12, color: "var(--app-text-dimmer)", flexShrink: 0 }} />
          }
        </div>
      </button>

      {/* Expanded detail section */}
      {expanded && (
        <div className="flex flex-col gap-3 px-3 pb-4" style={{ borderTop: `1px solid ${accentCol}22` }}>

          {/* Phase timeline */}
          <div className="pt-3">
            <PhaseTimeline phase={phase} />
          </div>

          {/* ── Buy / Sell cards ── */}
          <div className="grid grid-cols-2 gap-2">
            {/* BUY */}
            <div className="flex flex-col gap-0 rounded-xl overflow-hidden"
              style={{ border: "1px solid var(--app-success-border)" }}>
              <div className="flex items-center gap-2 px-2.5 py-2"
                style={{ background: "var(--app-success-soft)", borderBottom: "1px solid var(--app-success-border)" }}>
                <ExLogo exchange={trade.buyExchange} size={20} />
                <div className="flex flex-col leading-none">
                  <span className="text-[8px] font-extrabold uppercase tracking-widest" style={{ color: "var(--app-success)" }}>BUY</span>
                  <span className="text-[9px] font-bold capitalize" style={{ color: "var(--app-text-muted)" }}>{trade.buyExchange}</span>
                </div>
              </div>
              <div className="flex flex-col gap-0 divide-y"
                style={{ background: "var(--app-surface-1)", borderColor: "var(--app-border-0)" }}>
                <TxRow label="Amount"    value={trade.tradeAmountUSDT != null ? `$${trade.tradeAmountUSDT}` : null} accent />
                <TxRow label="Price"     value={fmtPrice(trade.executedBuyPrice)} />
                <TxRow label="Quantity"  value={fmtQty(trade.executedBuyQty, trade.symbol)} />
                <TxRow label="Maker Fee" value={trade.makerFee != null && trade.tradeAmountUSDT != null
                  ? `$${(trade.makerFee * trade.tradeAmountUSDT).toFixed(4)}` : null} />
                <TxRow label="Order ID"  value={trade.buyOrderId} mono truncate />
                <TxRow label="Time"      value={trade.timestamp ? new Date(trade.timestamp).toLocaleString() : null} mono small />
              </div>
            </div>

            {/* SELL */}
            <div className="flex flex-col gap-0 rounded-xl overflow-hidden"
              style={{ border: "1px solid var(--app-danger-border)" }}>
              <div className="flex items-center gap-2 px-2.5 py-2"
                style={{ background: "var(--app-danger-soft)", borderBottom: "1px solid var(--app-danger-border)" }}>
                <ExLogo exchange={trade.sellExchange} size={20} />
                <div className="flex flex-col leading-none">
                  <span className="text-[8px] font-extrabold uppercase tracking-widest" style={{ color: "var(--app-danger)" }}>SELL</span>
                  <span className="text-[9px] font-bold capitalize" style={{ color: "var(--app-text-muted)" }}>{trade.sellExchange}</span>
                </div>
                {trade.executedSellPrice == null && (
                  <span className="ml-auto text-[7px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full"
                    style={{ background: "rgba(251,146,60,0.15)", color: "#fb923c", border: "1px solid rgba(251,146,60,0.35)" }}>
                    Pending
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-0 divide-y"
                style={{ background: "var(--app-surface-1)", borderColor: "var(--app-border-0)" }}>
                <TxRow label="Price"     value={fmtPrice(trade.executedSellPrice)}  showDash />
                <TxRow label="Quantity"  value={fmtQty(trade.executedSellQty, trade.symbol)} showDash />
                <TxRow label="Taker Fee" value={trade.takerFee != null && trade.executedSellPrice != null && trade.executedSellQty != null
                  ? `$${(trade.takerFee * trade.executedSellPrice * trade.executedSellQty).toFixed(4)}` : null} showDash />
                <TxRow label="1% TDS"    value={trade.executedSellPrice != null && trade.executedSellQty != null
                  ? `$${(trade.executedSellPrice * trade.executedSellQty * 0.01).toFixed(4)}` : null} accent showDash />
                <TxRow label="Order ID"  value={trade.sellOrderId} mono truncate showDash />
                <TxRow label="Time"      value={trade.completedAt ? new Date(trade.completedAt).toLocaleString() : null} mono small showDash />
              </div>
            </div>
          </div>

          {/* ── Transfer Details ── */}
          {(trade.transferNetwork || trade.withdrawalId || trade.depositedQty != null || trade.depositAddress) && (
            <div className="flex flex-col gap-0 rounded-xl overflow-hidden"
              style={{ border: "1px solid var(--app-border-1)" }}>
              <div className="flex items-center gap-1.5 px-3 py-2"
                style={{ background: "var(--app-surface-2)", borderBottom: "1px solid var(--app-border-0)" }}>
                <Network style={{ width: 9, height: 9, color: "var(--app-text-dimmer)" }} />
                <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                  Transfer Details
                </span>
              </div>
              <div className="flex flex-col gap-0 divide-y"
                style={{ background: "var(--app-surface-1)", borderColor: "var(--app-border-0)" }}>
                <TxRow label="Network"
                  value={trade.transferNetwork && trade.transferNetworkNative
                    ? `${trade.transferNetwork} (${trade.transferNetworkNative})` : trade.transferNetwork} />
                <TxRow label="Deposit Addr"  value={trade.depositAddress} mono truncate />
                <TxRow label="Wdrl ID"       value={trade.withdrawalId} mono truncate />
                <TxRow label="Wdrl Amount"   value={trade.executedBuyQty != null ? fmtQty(trade.executedBuyQty, trade.symbol) : null} />
                <TxRow label="Wdrl Fees"     value={trade.withdrawalFeeQty != null ? fmtQty(trade.withdrawalFeeQty, trade.symbol) : null} />
                <TxRow label="Wdrl Status"   value={trade.withdrawalStatus?.toUpperCase()} />
                <TxRow label="Dep Status"
                  value={trade.withdrawalTxId ? "CONFIRMED" : trade.depositedQty != null ? "RECEIVED" : null} />
                <TxRow label="Dep Amount"    value={fmtQty(trade.depositedQty, trade.symbol)} />
                <TxRow label="Dep Fees"
                  value={trade.depositFeeQty != null
                    ? fmtQty(trade.depositFeeQty, trade.symbol)
                    : trade.executedBuyQty != null && trade.depositedQty != null
                      ? fmtQty(parseFloat((trade.executedBuyQty - trade.depositedQty).toFixed(6)), trade.symbol)
                      : null} />
              </div>
            </div>
          )}

          {/* ── Trade Cycle ── */}
          {(() => {
            const cycleRows = [
              trade.withdrawalInitiatedAt
                ? { label: "BUY", dur: trade.withdrawalInitiatedAt - trade.timestamp } : null,
              trade.withdrawalInitiatedAt && trade.monitoringStartAt
                ? { label: "XFER+DEP", dur: trade.monitoringStartAt - trade.withdrawalInitiatedAt } : null,
              trade.monitoringStartAt && trade.completedAt
                ? { label: "MONITOR", dur: trade.completedAt - trade.monitoringStartAt } : null,
            ].filter(Boolean);
            return cycleRows.length > 0 ? (
              <div className="flex flex-col gap-1.5 rounded-xl px-3 py-2.5"
                style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)" }}>
                <div className="flex items-center gap-1.5">
                  <Clock style={{ width: 9, height: 9, color: "var(--app-text-dimmer)" }} />
                  <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>Trade Cycle</span>
                  <span className="ml-auto text-[9px] font-bold font-mono" style={{ color: "var(--app-text-muted)" }}>
                    {fmtDuration(tradeDuration)}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  {cycleRows.map(({ label, dur }) => (
                    <div key={label} className="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg flex-1"
                      style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)" }}>
                      <span className="text-[7px] font-bold uppercase tracking-widest"
                        style={{ color: "var(--app-text-dimmer)" }}>{label}</span>
                      <span className="text-[10px] font-extrabold font-mono"
                        style={{ color: "var(--app-text-muted)" }}>{fmtDuration(dur)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}

          {/* Error */}
          {isFailed && trade.error && (
            <div className="flex items-start gap-2 rounded-xl px-3 py-2.5"
              style={{ background: "var(--app-danger-soft)", border: "1px solid var(--app-danger-border)" }}>
              <AlertTriangle style={{ width: 11, height: 11, color: "var(--app-danger)", flexShrink: 0, marginTop: 1 }} />
              <span className="text-[9px] break-all leading-relaxed" style={{ color: "var(--app-danger)" }}>
                {trade.error}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Stats Bar ─────────────────────────────────────────────────────────────────

function StatsBar({ trades, activeTrade }) {
  const total   = trades.length;
  const wins    = trades.filter((t) => t.phase === "completed" && (t.actualNetProfitPct ?? 0) >= 0).length;
  const losses  = trades.filter((t) => t.phase === "completed" && (t.actualNetProfitPct ?? 0) < 0).length;
  const failed  = trades.filter((t) => t.phase === "failed").length;
  const completed = wins + losses;
  const winRate = completed > 0 ? (wins / completed) * 100 : null;
  const totalPnlPct = trades
    .filter((t) => t.actualNetProfitPct != null)
    .reduce((s, t) => s + t.actualNetProfitPct, 0);
  const totalPnlUSDT = trades
    .filter((t) => t.actualNetProfitPct != null && t.tradeAmountUSDT != null)
    .reduce((s, t) => s + (t.tradeAmountUSDT * t.actualNetProfitPct / 100), 0);

  const pnlPositive = totalPnlPct >= 0;
  const pnlCol      = completed > 0 ? (pnlPositive ? "var(--app-success)" : "var(--app-danger)") : "var(--app-text-dimmer)";
  const wrCol       = winRate == null ? "var(--app-text-dimmer)" : winRate >= 50 ? "var(--app-success)" : "var(--app-danger)";

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-1)" }}>

      {/* ── Primary stats row ── */}
      <div className="grid grid-cols-3 divide-x" style={{ borderColor: "var(--app-border-1)" }}>

        {/* P&L */}
        <div className="flex flex-col gap-1 px-5 py-4">
          <div className="flex items-center gap-1.5">
            <DollarSign style={{ width: 10, height: 10, color: pnlCol }} />
            <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
              Realized P&amp;L
            </span>
          </div>
          <span className="text-[22px] font-extrabold font-mono leading-none" style={{ color: pnlCol }}>
            {completed > 0 ? `${pnlPositive ? "+" : ""}${totalPnlPct.toFixed(2)}%` : "—"}
          </span>
          {completed > 0 && (
            <span className="text-[10px] font-bold font-mono" style={{ color: pnlCol + "cc" }}>
              {totalPnlUSDT >= 0 ? "+" : ""}${Math.abs(totalPnlUSDT).toFixed(2)} USDT
            </span>
          )}
        </div>

        {/* Win Rate */}
        <div className="flex flex-col gap-1 px-5 py-4 items-center justify-center">
          <div className="flex items-center gap-1.5">
            <TrendingUp style={{ width: 10, height: 10, color: wrCol }} />
            <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
              Win Rate
            </span>
          </div>
          <span className="text-[22px] font-extrabold font-mono leading-none" style={{ color: wrCol }}>
            {winRate != null ? `${winRate.toFixed(0)}%` : "—"}
          </span>
          <span className="text-[9px] font-bold font-mono" style={{ color: "var(--app-text-dimmer)" }}>
            {completed > 0 ? `${wins}W  ${losses}L` : "No closed trades"}
          </span>
        </div>

        {/* Total */}
        <div className="flex flex-col gap-1 px-5 py-4 items-end">
          <div className="flex items-center gap-1.5">
            <Layers style={{ width: 10, height: 10, color: "var(--app-text-muted)" }} />
            <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
              Total Trades
            </span>
          </div>
          <span className="text-[22px] font-extrabold font-mono leading-none" style={{ color: "var(--app-text-bright)" }}>
            {total + (activeTrade ? 1 : 0)}
          </span>
          <span className="text-[9px] font-bold font-mono" style={{ color: failed > 0 ? "var(--app-danger)" : "var(--app-text-dimmer)" }}>
            {failed > 0 ? `${failed} failed` : "No failures"}
          </span>
        </div>
      </div>

      {/* ── Secondary stats strip ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x" style={{ borderTop: "1px solid var(--app-border-0)", borderColor: "var(--app-border-0)" }}>
        {[
          { label: "Completed", val: completed,           col: "var(--app-success)", icon: CheckCircle2 },
          { label: "Active",    val: activeTrade ? 1 : 0, col: "#60a5fa",            icon: Activity     },
          { label: "Failed",    val: failed,              col: "var(--app-danger)",  icon: XCircle      },
        ].map(({ label, val, col, icon: Icon }) => (
          <div key={label} className="flex items-center justify-center gap-2 py-2.5 px-3">
            <Icon style={{ width: 11, height: 11, color: val > 0 ? col : "var(--app-border-1)", flexShrink: 0 }} />
            <div className="flex flex-col gap-0 min-w-0">
              <span className="text-[13px] font-extrabold font-mono leading-none"
                style={{ color: val > 0 ? col : "var(--app-text-dimmer)" }}>
                {val}
              </span>
              <span className="text-[7px] font-bold uppercase tracking-widest"
                style={{ color: "var(--app-text-dimmer)" }}>
                {label}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ── Main TradesTab ─────────────────────────────────────────────────────────────

// Time filter windows — ms: null means "no cutoff" (handled in filter logic)
const TIME_FILTERS = [
  { id: "today",     label: "Today",     ms: null },
  { id: "yesterday", label: "Yesterday", ms: null },
  { id: "7d",        label: "7 Days",    ms: 7  * 24 * 60 * 60_000 },
  { id: "30d",       label: "30 Days",   ms: 30 * 24 * 60 * 60_000 },
  { id: "month",     label: "Month",     ms: null },
  { id: "quarter",   label: "Quarter",   ms: null },
  { id: "year",      label: "Year",      ms: null },
  { id: "all",       label: "All Time",  ms: null },
  { id: "custom",    label: "Custom",    ms: null },
];

export function TradesTab() {
  const [now, setNow]           = useState(() => Date.now());
  const [tab, setTab]           = useState("all");    // "active" | "completed" | "failed" | "all"
  const [sort, setSort]         = useState("newest");
  const [timeWin, setTimeWin]   = useState("all");    // "1h" | "24h" | "7d" | "30d" | "all" | "custom"
  const [customFrom, setCustomFrom] = useState("");   // YYYY-MM-DD
  const [customTo,   setCustomTo]   = useState("");

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const { data: trades = [], isLoading, refetch } = useQuery({
    queryKey:        ["bot-trades"],
    queryFn:         async () => {
      const r = await fetch("/api/bot/trades");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 5_000,
    staleTime:       4_000,
  });

  const { data: activeTrade } = useQuery({
    queryKey:        ["bot-active-trade"],
    queryFn:         async () => {
      const r = await fetch("/api/bot/active-trade");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 3_000,
    staleTime:       2_000,
  });

  // Calendar helpers — compute start/end ms for named windows
  const calBounds = (() => {
    const d = new Date();
    const y = d.getFullYear(), m = d.getMonth();

    if (timeWin === "today") {
      const s = new Date(y, m, d.getDate()).getTime();
      return { from: s, to: null };
    }
    if (timeWin === "yesterday") {
      const s = new Date(y, m, d.getDate() - 1).getTime();
      const e = new Date(y, m, d.getDate()).getTime() - 1;
      return { from: s, to: e };
    }
    if (timeWin === "month") {
      return { from: new Date(y, m, 1).getTime(), to: null };
    }
    if (timeWin === "quarter") {
      const qStart = new Date(y, Math.floor(m / 3) * 3, 1).getTime();
      return { from: qStart, to: null };
    }
    if (timeWin === "year") {
      return { from: new Date(y, 0, 1).getTime(), to: null };
    }
    return null;
  })();

  // Rolling ms-based cutoff (7d, 30d)
  const timeCutoff = (() => {
    if (timeWin === "custom" || calBounds) return null;
    const win = TIME_FILTERS.find((f) => f.id === timeWin);
    return win?.ms != null ? now - win.ms : null;
  })();

  // Custom date range bounds (ms)
  const customFromMs = customFrom ? new Date(customFrom).getTime() : null;
  const customToMs   = customTo   ? new Date(customTo + "T23:59:59").getTime() : null;

  // Max date for calendar = today; min = 1 year ago
  const todayStr     = new Date().toISOString().slice(0, 10);
  const oneYearAgo   = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

  const counts = {
    active:    activeTrade ? 1 : 0,
    completed: trades.filter((t) => t.phase === "completed").length,
    failed:    trades.filter((t) => t.phase === "failed").length,
    all:       trades.length,
  };

  const filtered = trades
    .filter((t) => {
      if (tab === "completed" && t.phase !== "completed") return false;
      if (tab === "failed"    && t.phase !== "failed")    return false;
      if (timeWin === "custom") {
        if (customFromMs != null && t.timestamp < customFromMs) return false;
        if (customToMs   != null && t.timestamp > customToMs)   return false;
        return true;
      }
      if (calBounds) {
        if (t.timestamp < calBounds.from) return false;
        if (calBounds.to != null && t.timestamp > calBounds.to) return false;
        return true;
      }
      if (timeCutoff != null && t.timestamp < timeCutoff) return false;
      return true;
    })
    .sort((a, b) => {
      if (sort === "profit") {
        const pa = a.actualNetProfitPct ?? a.expectedNetProfitPct ?? -999;
        const pb = b.actualNetProfitPct ?? b.expectedNetProfitPct ?? -999;
        return pb - pa;
      }
      if (sort === "loss") {
        const pa = a.actualNetProfitPct ?? a.expectedNetProfitPct ?? 999;
        const pb = b.actualNetProfitPct ?? b.expectedNetProfitPct ?? 999;
        return pa - pb;
      }
      return b.timestamp - a.timestamp;
    });

  // Tab config
  const TABS = [
    {
      id: "active",
      label: "Active",
      icon: Activity,
      activeCol: "#60a5fa",
      activeBg:  "rgba(96,165,250,0.14)",
      activeBorder: "rgba(96,165,250,0.5)",
    },
    {
      id: "completed",
      label: "Completed",
      icon: CheckCircle2,
      activeCol: "var(--app-success)",
      activeBg:  "var(--app-success-soft)",
      activeBorder: "var(--app-success-border)",
    },
    {
      id: "failed",
      label: "Failed",
      icon: XCircle,
      activeCol: "var(--app-danger)",
      activeBg:  "var(--app-danger-soft)",
      activeBorder: "var(--app-danger-border)",
    },
    {
      id: "all",
      label: "All",
      icon: Layers,
      activeCol: "var(--app-text-bright)",
      activeBg:  "var(--app-surface-2)",
      activeBorder: "var(--app-border-1)",
    },
  ];

  const sortBtns = [
    { id: "newest", label: "Newest" },
    { id: "profit", label: "Best P&L" },
    { id: "loss",   label: "Worst" },
  ];

  const showHistory = tab !== "active";
  const emptyMsg = tab === "completed" ? "No completed trades yet"
    : tab === "failed" ? "No failed trades"
    : "No trades yet — use Sim Test to try the pipeline";

  return (
    <div className="flex flex-col gap-3">

      {/* Stats bar */}
      <StatsBar trades={trades} activeTrade={activeTrade} />

      {/* ── Tab Navigation ── */}
      <div className="flex items-stretch gap-1 p-1 rounded-2xl"
        style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)" }}>
        {TABS.map(({ id, label, icon: Icon, activeCol, activeBg, activeBorder }) => {
          const isActive = tab === id;
          const count    = counts[id] ?? 0;
          return (
            <button key={id} onClick={() => setTab(id)}
              className="flex items-center justify-center gap-2 flex-1 py-2.5 px-3 rounded-xl font-bold text-[11px] transition-all"
              style={{
                background: isActive ? activeBg    : "transparent",
                color:      isActive ? activeCol   : "var(--app-text-dimmer)",
                border:     `1px solid ${isActive ? activeBorder : "transparent"}`,
                cursor:     "pointer",
                boxShadow:  isActive ? `0 2px 14px ${activeCol}25` : "none",
                transition: "all 0.18s ease",
              }}>

              <Icon style={{ width: 13, height: 13, flexShrink: 0 }} />
              <span>{label}</span>

              {/* Count badge */}
              <span className="text-[9px] font-extrabold min-w-[20px] h-5 flex items-center justify-center rounded-full"
                style={{
                  background: isActive ? activeCol + "30" : "var(--app-surface-1)",
                  color:      isActive ? activeCol        : count > 0 ? "var(--app-text-muted)" : "var(--app-text-dimmer)",
                  border:     `1px solid ${isActive ? activeCol + "55" : "var(--app-border-0)"}`,
                  padding:    "0 5px",
                }}>
                {count}
              </span>

              {/* Live pulse dot for active trade */}
              {id === "active" && count > 0 && (
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                    style={{ background: "#60a5fa" }} />
                  <span className="relative inline-flex rounded-full h-2 w-2"
                    style={{ background: "#60a5fa" }} />
                </span>
              )}
            </button>
          );
        })}

        {/* Separator + Refresh */}
        <div className="w-px my-1.5 flex-shrink-0" style={{ background: "var(--app-border-1)" }} />
        <button onClick={() => refetch()}
          className="flex items-center justify-center w-10 rounded-xl flex-shrink-0 transition-colors"
          style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--app-text-muted)" }}>
          <RefreshCw style={{ width: 13, height: 13 }} />
        </button>
      </div>

      {/* Active trade tab content */}
      {tab === "active" && (
        activeTrade
          ? <ActiveTradeFullCard trade={activeTrade} now={now} />
          : (
            <div className="flex flex-col items-center justify-center gap-3 h-40 rounded-xl"
              style={{ background: "var(--app-surface-1)", border: "1px dashed var(--app-border-1)" }}>
              <Activity style={{ width: 24, height: 24, color: "var(--app-text-dimmer)" }} />
              <span className="text-xs font-bold" style={{ color: "var(--app-text-muted)" }}>
                No active trade right now
              </span>
            </div>
          )
      )}

      {/* History tabs content */}
      {showHistory && (
        <>
          {/* Time filter + sort row */}
          <div className="flex items-center justify-between gap-2 flex-wrap">

            {/* ── Time filter dropdown ── */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg"
                style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)" }}>
                <Clock style={{ width: 9, height: 9, color: "var(--app-text-dimmer)", flexShrink: 0 }} />
                <select
                  value={timeWin}
                  onChange={(e) => setTimeWin(e.target.value)}
                  style={{
                    background:  "transparent",
                    border:      "none",
                    outline:     "none",
                    color:       "#60a5fa",
                    fontSize:    10,
                    fontWeight:  700,
                    fontFamily:  "inherit",
                    cursor:      "pointer",
                    colorScheme: "dark",
                    paddingRight: 2,
                  }}
                >
                  {TIME_FILTERS.map(({ id, label }) => (
                    <option key={id} value={id}>{label}</option>
                  ))}
                </select>
              </div>

              {/* Date range pickers — shown only when Custom is active */}
              {timeWin === "custom" && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <input
                    type="date"
                    value={customFrom}
                    min={oneYearAgo}
                    max={customTo || todayStr}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="text-[9px] font-mono px-2 py-1 rounded-lg"
                    style={{
                      background:  "var(--app-surface-2)",
                      color:       "var(--app-text-muted)",
                      border:      "1px solid var(--app-border-1)",
                      colorScheme: "dark",
                      outline:     "none",
                    }}
                  />
                  <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>→</span>
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom || oneYearAgo}
                    max={todayStr}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="text-[9px] font-mono px-2 py-1 rounded-lg"
                    style={{
                      background:  "var(--app-surface-2)",
                      color:       "var(--app-text-muted)",
                      border:      "1px solid var(--app-border-1)",
                      colorScheme: "dark",
                      outline:     "none",
                    }}
                  />
                  {(customFrom || customTo) && (
                    <button onClick={() => { setCustomFrom(""); setCustomTo(""); }}
                      className="flex items-center justify-center w-5 h-5 rounded-md"
                      style={{ background: "var(--app-danger-soft)", border: "1px solid var(--app-danger-border)", cursor: "pointer" }}>
                      <X style={{ width: 8, height: 8, color: "var(--app-danger)" }} />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* ── Sort pills ── */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-xl"
              style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)" }}>
              {sortBtns.map(({ id, label }) => {
                const on = sort === id;
                return (
                  <button key={id} onClick={() => setSort(id)}
                    className="text-[9px] font-bold uppercase px-2.5 py-1.5 rounded-lg transition-all"
                    style={{
                      background: on ? "var(--app-surface-1)" : "transparent",
                      color:      on ? "var(--app-text-bright)" : "var(--app-text-dimmer)",
                      border:     `1px solid ${on ? "var(--app-border-1)" : "transparent"}`,
                      cursor:     "pointer",
                      transition: "all 0.15s ease",
                    }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center h-32 rounded-xl"
              style={{ background: "var(--app-surface-1)", border: "1px dashed var(--app-border-1)" }}>
              <RefreshCw style={{ width: 18, height: 18, color: "var(--app-text-dimmer)", animation: "spin 1s linear infinite" }} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 h-40 rounded-xl"
              style={{ background: "var(--app-surface-1)", border: "1px dashed var(--app-border-1)" }}>
              <BarChart2 style={{ width: 28, height: 28, color: "var(--app-text-dimmer)" }} />
              <span className="text-xs font-bold" style={{ color: "var(--app-text-muted)" }}>
                {(timeCutoff != null || calBounds != null)
                  ? `No trades for ${TIME_FILTERS.find(f => f.id === timeWin)?.label}`
                  : emptyMsg}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((t) => (
                <TradeHistoryCard key={t.id} trade={t} now={now} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
