import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot, BotOff, Zap, Clock,
  Settings2, X,
  CheckCircle2, Circle, AlertTriangle, Activity,
} from "lucide-react";
import { ExchangeIcon } from "./ExchangeIcon.jsx";

const ALL_EXCHANGES = ["binance", "bybit", "kucoin", "bitget"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAge(ms) {
  if (ms < 60_000)    return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60)     return `${s}s`;
  if (s < 3600)   return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

function phaseColor(p) {
  if (p === "completed")           return "var(--app-success)";
  if (p === "failed")              return "var(--app-danger)";
  if (p === "monitoring")          return "#60a5fa";
  if (p === "waiting_deposit")     return "var(--app-warning)";
  if (p === "waiting_withdrawal")  return "#fb923c";
  if (p === "selling")             return "#a78bfa";
  if (p === "transferring")        return "#fb923c";
  return "var(--app-text-muted)";
}
function phaseBg(p) {
  if (p === "completed")           return "var(--app-success-soft)";
  if (p === "failed")              return "var(--app-danger-soft)";
  if (p === "monitoring")          return "rgba(96,165,250,0.12)";
  if (p === "waiting_deposit")     return "var(--app-warning-soft)";
  if (p === "waiting_withdrawal")  return "rgba(251,146,60,0.12)";
  if (p === "selling")             return "rgba(167,139,250,0.12)";
  if (p === "transferring")        return "rgba(251,146,60,0.12)";
  return "var(--app-surface-2)";
}
function phaseLabel(p) {
  return ({
    buying:             "BUY",
    transferring:       "TRANSFER",
    waiting_withdrawal: "W.DRAW",
    waiting_deposit:    "DEPOSIT",
    monitoring:         "MONITOR",
    selling:            "SELL",
    completed:          "DONE",
    failed:             "FAILED",
  })[p] ?? p?.toUpperCase() ?? "?";
}

function statusColor(s) { return phaseColor(s); }
function statusBg(s)    { return phaseBg(s); }
function statusLabel(s) { return phaseLabel(s); }

// ── Reusable UI components ────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled, color = "var(--app-success)", size = "md" }) {
  const W = size === "sm" ? 38 : 46;
  const H = size === "sm" ? 22 : 26;
  const D = size === "sm" ? 16 : 20;
  const PAD = 4;
  const [squish, setSquish] = useState(false);

  const handleClick = () => {
    if (disabled) return;
    setSquish(true);
    onChange(!checked);
    setTimeout(() => setSquish(false), 220);
  };

  const extraW    = squish ? Math.round(D * 0.45) : 0;
  const thumbW    = D + extraW;
  const thumbLeft = checked ? W - thumbW - PAD : PAD;

  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={handleClick}
      style={{
        width: W, height: H, borderRadius: H / 2,
        background: checked ? color : "var(--app-surface-2)",
        border: `1.5px solid ${checked ? color : "var(--app-border-1)"}`,
        boxShadow: checked ? `0 0 10px ${color}55` : "inset 0 2px 4px rgba(0,0,0,0.3)",
        position: "relative", cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.22s, border-color 0.22s, box-shadow 0.22s",
        flexShrink: 0, opacity: disabled ? 0.45 : 1,
        padding: 0, outline: "none", display: "block",
      }}
    >
      <span style={{
        position: "absolute",
        top: "50%",
        left: thumbLeft,
        width: thumbW,
        height: D,
        borderRadius: D / 2,
        background: "#ffffff",
        boxShadow: "0 1px 5px rgba(0,0,0,0.4)",
        transform: "translateY(-50%)",
        transition: "left 0.22s ease, width 0.14s ease, border-radius 0.14s ease",
        display: "block",
      }} />
    </button>
  );
}

function FieldInput({ label, value, onChange, step = 1, min = 0, suffix, hint }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-widest truncate" style={{ color: "var(--app-text-muted)" }}>
          {label}
        </span>
        {hint && (
          <span className="text-[8px] italic whitespace-nowrap flex-shrink-0" style={{ color: "var(--app-text-dimmer)" }}>
            {hint}
          </span>
        )}
      </div>
      <div className="flex items-center h-8 rounded-lg"
        style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-1)", overflow: "hidden" }}>
        <input
          type="number" step={step} min={min}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 w-0 flex-1 h-full px-2.5 text-[13px] font-bold font-mono outline-none bg-transparent"
          style={{ color: "var(--app-text-bright)" }}
        />
        {suffix && (
          <span className="px-2.5 h-full flex items-center text-[10px] font-bold tracking-wider whitespace-nowrap flex-shrink-0"
            style={{ background: "var(--app-surface-2)", borderLeft: "1px solid var(--app-border-1)", color: "var(--app-text-muted)" }}>
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function SelectInput({ label, value, onChange, options, hint }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
          {label}
        </span>
        {hint && <span className="text-[8px] italic" style={{ color: "var(--app-text-dimmer)" }}>{hint}</span>}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 px-2.5 rounded-lg text-xs font-bold outline-none appearance-none"
        style={{
          background: "var(--app-bg)", border: "1px solid var(--app-border-1)",
          color: "var(--app-text-bright)", cursor: "pointer",
        }}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}


// ── Active Trade Progress Card ─────────────────────────────────────────────────

const PHASE_STEPS = ["buying", "transferring", "waiting_withdrawal", "waiting_deposit", "monitoring", "selling"];
const PHASE_SHORT = ["BUY",   "XFER",         "W.DRAW",             "DEPOSIT",        "MONITOR",   "SELL"];

function PhaseStepper({ phase }) {
  const isFailed = phase === "failed";
  const isDone   = phase === "completed";
  const phaseIdx = PHASE_STEPS.indexOf(phase);

  return (
    <div className="flex items-start w-full">
      {PHASE_STEPS.map((p, i) => {
        const done   = !isFailed && (isDone || phaseIdx > i);
        const active = !isDone && !isFailed && phase === p;
        const fail   = isFailed && phase === p;
        const col = fail    ? "var(--app-danger)"
          : done   ? "var(--app-success)"
          : active ? "#60a5fa"
          : "var(--app-border-1)";
        return (
          <div key={p} className="flex items-start"
            style={{ flex: i < PHASE_STEPS.length - 1 ? "1 1 0%" : "0 0 auto" }}>
            <div className="flex flex-col items-center gap-1 flex-shrink-0">
              <div className="flex items-center justify-center rounded-full"
                style={{ width: 26, height: 26, border: `2px solid ${col}`,
                  background: (done || active || fail) ? col + "1e" : "var(--app-surface-2)",
                  transition: "all 0.3s" }}>
                {done   && <CheckCircle2 style={{ width: 12, height: 12, color: col }} />}
                {active && <Activity style={{ width: 12, height: 12, color: col, animation: "spin 2s linear infinite" }} />}
                {fail   && <AlertTriangle style={{ width: 12, height: 12, color: col }} />}
                {!done && !active && !fail && <Circle style={{ width: 7, height: 7, color: col }} />}
              </div>
              <span className="text-[7.5px] font-bold text-center"
                style={{ color: col, letterSpacing: "0.04em", lineHeight: 1 }}>
                {PHASE_SHORT[i]}
              </span>
            </div>
            {i < PHASE_STEPS.length - 1 && (
              <div style={{
                flex: 1, height: 2, marginTop: 12, marginLeft: 4, marginRight: 4,
                background: (!isFailed && (isDone || phaseIdx > i)) ? "var(--app-success)" : "var(--app-border-1)",
                borderRadius: 2, transition: "background 0.3s",
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ActiveTradeCard({ trade, now }) {
  const phase   = trade.phase;
  const isFailed = phase === "failed";
  const isDone   = phase === "completed";
  const phaseIdx = PHASE_STEPS.indexOf(phase);

  const elapsed = now - trade.timestamp;
  const monAge  = trade.monitoringStartAt ? now - trade.monitoringStartAt : 0;
  const depAge  = trade.withdrawalInitiatedAt ? now - trade.withdrawalInitiatedAt : 0;

  const accentCol = isFailed ? "var(--app-danger)"
    : isDone      ? "var(--app-success)"
    : phase === "monitoring"          ? "#60a5fa"
    : phase === "waiting_deposit"     ? "var(--app-warning)"
    : phase === "waiting_withdrawal"  ? "#fb923c"
    : phase === "transferring"        ? "#fb923c"
    : "var(--app-text-muted)";

  return (
    <div className="rounded-xl flex flex-col gap-3 p-3"
      style={{ background: "var(--app-surface-1)", border: `1px solid ${accentCol}44`, boxShadow: `0 0 0 1px ${accentCol}22` }}>

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {isDone
            ? <CheckCircle2 style={{ width: 12, height: 12, color: accentCol }} />
            : isFailed
            ? <AlertTriangle style={{ width: 12, height: 12, color: accentCol }} />
            : <Activity style={{ width: 12, height: 12, color: accentCol, animation: "spin 2s linear infinite" }} />
          }
          <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: accentCol }}>
            {isDone ? "Completed" : isFailed ? "Failed" : "Active Trade"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold font-mono" style={{ color: "var(--app-success)" }}>
            {trade.symbol}
          </span>
          <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>
            {trade.buyExchange} → {trade.sellExchange}
          </span>
          <span className="text-[8px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
            {fmtDuration(elapsed)}
          </span>
        </div>
      </div>

      {/* Phase stepper */}
      <PhaseStepper phase={phase} />

      {/* Phase-specific details */}
      <div className="flex flex-col gap-1.5">
        {/* Buy info */}
        {trade.executedBuyQty != null && (
          <div className="flex items-center justify-between text-[9px]">
            <span style={{ color: "var(--app-text-dimmer)" }}>Bought</span>
            <span className="font-mono font-bold" style={{ color: "var(--app-text-muted)" }}>
              {trade.executedBuyQty.toFixed(6)} {trade.symbol} @ ${trade.buyAsk?.toFixed(4)}
            </span>
          </div>
        )}

        {/* Transfer info */}
        {trade.transferNetwork && (
          <div className="flex items-center justify-between text-[9px]">
            <span style={{ color: "var(--app-text-dimmer)" }}>Network</span>
            <span className="font-mono" style={{ color: "var(--app-text-muted)" }}>
              {trade.transferNetwork} ({trade.transferNetworkNative})
            </span>
          </div>
        )}
        {trade.withdrawalId && (
          <div className="flex items-center justify-between text-[9px]">
            <span style={{ color: "var(--app-text-dimmer)" }}>Withdrawal ID</span>
            <span className="font-mono text-[8px]" style={{ color: "var(--app-text-dimmer)" }}>
              {trade.withdrawalId.slice(0, 20)}{trade.withdrawalId.length > 20 ? "…" : ""}
            </span>
          </div>
        )}
        {/* Withdrawal tracking (waiting_withdrawal phase) */}
        {phase === "waiting_withdrawal" && (
          <div className="flex items-center justify-between text-[9px]">
            <span style={{ color: "var(--app-text-dimmer)" }}>Withdrawal status</span>
            <span className="font-bold" style={{
              color: trade.withdrawalStatus === "success"    ? "var(--app-success)"
                   : trade.withdrawalStatus === "processing" ? "#fb923c"
                   : "var(--app-text-muted)"
            }}>
              {(trade.withdrawalStatus ?? "pending").toUpperCase()}
              {trade.withdrawalTxId && " · tx confirmed"}
            </span>
          </div>
        )}
        {phase === "waiting_withdrawal" && (
          <div className="flex items-center justify-between text-[9px]">
            <span style={{ color: "var(--app-text-dimmer)" }}>Polling every</span>
            <span className="font-mono" style={{ color: "#fb923c" }}>3s</span>
          </div>
        )}

        {/* Withdrawal confirmed → waiting deposit */}
        {trade.withdrawalStatus && (phase === "waiting_deposit" || phase === "monitoring" || phase === "selling" || phase === "completed") && (
          <div className="flex items-center justify-between text-[9px]">
            <span style={{ color: "var(--app-text-dimmer)" }}>Withdrawal</span>
            <span className="font-bold" style={{ color: "var(--app-success)" }}>
              SUCCESS{trade.withdrawalTxId && " · tx confirmed"}
            </span>
          </div>
        )}

        {/* Deposit waiting */}
        {phase === "waiting_deposit" && (
          <div className="flex items-center justify-between text-[9px]">
            <span style={{ color: "var(--app-text-dimmer)" }}>Waiting deposit</span>
            <span className="font-mono" style={{ color: "var(--app-warning)" }}>
              {fmtDuration(depAge)} elapsed
            </span>
          </div>
        )}

        {/* Deposited qty */}
        {trade.depositedQty != null && (
          <div className="flex items-center justify-between text-[9px]">
            <span style={{ color: "var(--app-text-dimmer)" }}>Deposited</span>
            <span className="font-mono font-bold" style={{ color: "var(--app-success)" }}>
              {trade.depositedQty.toFixed(6)} {trade.symbol}
            </span>
          </div>
        )}

        {/* Monitoring live profit */}
        {(phase === "monitoring" || phase === "selling") && trade.currentBid != null && (
          <>
            <div className="flex items-center justify-between text-[9px]">
              <span style={{ color: "var(--app-text-dimmer)" }}>Live bid ({trade.sellExchange})</span>
              <span className="font-mono font-bold" style={{ color: "#60a5fa" }}>
                ${trade.currentBid.toFixed(4)}
              </span>
            </div>
            <div className="flex items-center justify-between text-[9px]">
              <span style={{ color: "var(--app-text-dimmer)" }}>Live net profit</span>
              <span className="font-mono font-bold" style={{ color: (trade.currentNetProfitPct ?? 0) >= 0 ? "var(--app-success)" : "var(--app-danger)" }}>
                {(trade.currentNetProfitPct ?? 0) >= 0 ? "+" : ""}{(trade.currentNetProfitPct ?? 0).toFixed(3)}%
                <span style={{ color: "var(--app-text-dimmer)", fontWeight: 400 }}> (target: +{trade.expectedNetProfitPct?.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="flex items-center justify-between text-[9px]">
              <span style={{ color: "var(--app-text-dimmer)" }}>Monitoring duration</span>
              <span className="font-mono" style={{ color: "var(--app-text-muted)" }}>{fmtDuration(monAge)}</span>
            </div>
          </>
        )}

        {/* Completed */}
        {isDone && trade.actualNetProfitPct != null && (
          <div className="flex items-center justify-between text-[9px]">
            <span style={{ color: "var(--app-text-dimmer)" }}>Actual P&amp;L</span>
            <span className="font-mono font-bold text-[11px]"
              style={{ color: trade.actualNetProfitPct >= 0 ? "var(--app-success)" : "var(--app-danger)" }}>
              {trade.actualNetProfitPct >= 0 ? "+" : ""}{trade.actualNetProfitPct.toFixed(3)}%
              {" "}(${(trade.tradeAmountUSDT * trade.actualNetProfitPct / 100).toFixed(2)})
            </span>
          </div>
        )}

        {/* Error */}
        {isFailed && trade.error && (
          <div className="flex items-start gap-1.5 rounded-lg px-2 py-1.5"
            style={{ background: "var(--app-danger-soft)", border: "1px solid var(--app-danger-border)" }}>
            <AlertTriangle style={{ width: 10, height: 10, color: "var(--app-danger)", flexShrink: 0, marginTop: 1 }} />
            <span className="text-[9px]" style={{ color: "var(--app-danger)" }}>{trade.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Filter Popup ──────────────────────────────────────────────────────────────

// ── Section header helper ──────────────────────────────────────────────────────
function SectionHeader({ color = "var(--app-text-dimmer)", label }) {
  return (
    <div className="flex items-center gap-2 mb-1">
      <div style={{ width: 3, height: 13, borderRadius: 2, background: color, flexShrink: 0 }} />
      <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
        {label}
      </span>
    </div>
  );
}

// ── Toggle row (for boolean fields) ──────────────────────────────────────────
function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 h-9 px-3 rounded-lg"
      style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-1)" }}>
      <div className="flex flex-col min-w-0">
        <span className="text-[11px] font-bold truncate" style={{ color: "var(--app-text-bright)" }}>{label}</span>
        {hint && <span className="text-[9px] truncate" style={{ color: "var(--app-text-dimmer)" }}>{hint}</span>}
      </div>
      <Toggle checked={checked} onChange={onChange} size="sm" />
    </div>
  );
}

// ── Inline number + dropdown (for movement filter) ────────────────────────────
function MovementInput({ value, onChange, window, onWindowChange }) {
  const WINDOWS = ["4H", "8H", "12H", "24H"];
  const numVal  = parseFloat(value);
  const isActive = isFinite(numVal) && numVal > 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
          Max Price Movement
        </span>
        <span className="text-[8px] italic" style={{ color: "var(--app-text-dimmer)" }}>sell-side, 0 = no cap</span>
      </div>
      <div className="flex gap-2">
        <div className="flex items-center flex-1 h-8 rounded-lg"
          style={{ background: "var(--app-bg)", border: `1px solid ${isActive ? "var(--app-success-border)" : "var(--app-border-1)"}`, overflow: "hidden" }}>
          <input
            type="number" step={0.5} min={0}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="min-w-0 w-0 flex-1 h-full px-2.5 text-[13px] font-bold font-mono outline-none bg-transparent"
            style={{ color: "var(--app-text-bright)" }}
          />
          <span className="px-2.5 h-full flex items-center text-[10px] font-bold tracking-wider"
            style={{ background: "var(--app-surface-2)", borderLeft: "1px solid var(--app-border-1)", color: "var(--app-text-muted)" }}>
            %
          </span>
        </div>
        <select
          value={window}
          onChange={(e) => onWindowChange(e.target.value)}
          className="h-8 px-2 rounded-lg text-xs font-bold outline-none appearance-none"
          style={{
            background: "var(--app-bg)", border: `1px solid ${isActive ? "var(--app-success-border)" : "var(--app-border-1)"}`,
            color: "var(--app-text-bright)", cursor: "pointer", minWidth: 52,
          }}>
          {WINDOWS.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>

      {/* Positive-only rule indicator */}
      {isActive ? (
        <div
          className="flex items-center justify-between gap-2 px-2 py-1 rounded-md"
          style={{ background: "var(--app-success-soft)", border: "1px solid var(--app-success-border)" }}
          title={`Bot will SKIP any pair where ${window} price movement is negative (dropping) OR exceeds +${numVal}%. Allowed range: 0% to +${numVal}%.`}
        >
          <span className="text-[8px] font-extrabold uppercase tracking-wider" style={{ color: "var(--app-success)" }}>
            ↑ Positive only
          </span>
          <span className="text-[9px] font-mono font-bold" style={{ color: "var(--app-success)" }}>
            0% → +{numVal}%
          </span>
          <span className="text-[8px]" style={{ color: "var(--app-text-dimmer)" }}>
            negative = skip ✗
          </span>
        </div>
      ) : (
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded-md"
          style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)" }}
          title="Set a value > 0 to activate. When active, negative movement (price dropping) is also rejected."
        >
          <span className="text-[8px]" style={{ color: "var(--app-text-dimmer)" }}>
            No cap — set &gt; 0 to activate · also enforces movement ≥ 0%
          </span>
        </div>
      )}
    </div>
  );
}

function FilterPopup({ currentCfg, onConfirm, onCancel, mode }) {
  const [form, setForm] = useState({
    // Opportunity filters
    minNetProfitPct:        String(currentCfg.minNetProfitPct        ?? 1.0),
    minTimesHit:            String(currentCfg.minTimesHit            ?? 3),
    maxMovementPct:         String(currentCfg.maxMovementPct         ?? 0),
    priceMovementWindow:    currentCfg.priceMovementWindow            ?? "4H",
    requireAddressVerified: currentCfg.requireAddressVerified         ?? false,
    maxWithdrawFeeUSD:      String(currentCfg.maxWithdrawFeeUSD      ?? 0),
    // Trade settings
    tradeAmountUSDT:        String(currentCfg.tradeAmountUSDT        ?? 100),
    takeProfitPct:          String(currentCfg.takeProfitPct          ?? 1.0),
    maxOpenPositions:       String(currentCfg.maxOpenPositions        ?? 1),
    // Exchanges
    allowedExchanges:       currentCfg.allowedExchanges               ?? ALL_EXCHANGES,
  });

  const set    = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setBool= (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const toggleEx = (ex) => {
    const cur  = form.allowedExchanges;
    const next = cur.includes(ex) ? cur.filter((e) => e !== ex) : [...cur, ex];
    if (next.length === 0) return;
    setForm((f) => ({ ...f, allowedExchanges: next }));
  };

  const p = (raw, fallback) => { const v = parseFloat(raw); return isFinite(v) ? v : fallback; };

  const handleStart = () => {
    onConfirm({
      enabled:                true,
      // Opportunity filters
      minNetProfitPct:        p(form.minNetProfitPct,   1.0),
      minTimesHit:            Math.max(0, Math.floor(p(form.minTimesHit, 3))),
      maxMovementPct:         p(form.maxMovementPct,    0),
      priceMovementWindow:    form.priceMovementWindow,
      requireAddressVerified: form.requireAddressVerified,
      maxWithdrawFeeUSD:      p(form.maxWithdrawFeeUSD, 0),
      // Trade settings
      tradeAmountUSDT:        p(form.tradeAmountUSDT,   100),
      takeProfitPct:          p(form.takeProfitPct,     1.0),
      maxOpenPositions:       Math.max(1, Math.floor(p(form.maxOpenPositions, 1))),
      allowedExchanges:       form.allowedExchanges,
    });
  };

  const isEdit = mode === "edit";
  const accentColor  = isEdit ? "var(--app-warning)"        : "var(--app-success)";
  const accentSoft   = isEdit ? "var(--app-warning-soft)"   : "var(--app-success-soft)";
  const accentBorder = isEdit ? "var(--app-warning-border)" : "var(--app-success-border)";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", animation: "backdrop-in 0.18s ease both" }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>

      <div className="w-full max-w-lg rounded-2xl overflow-hidden flex flex-col max-h-[92dvh]"
        style={{
          background: "var(--app-surface-1)",
          border: "1px solid var(--app-border-1)",
          boxShadow: "0 40px 100px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.04)",
          animation: "modal-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        }}>

        {/* ── Header ── */}
        <div className="relative flex items-center justify-between px-5 py-4"
          style={{
            background: "linear-gradient(135deg, var(--app-surface-2) 0%, var(--app-surface-1) 100%)",
            borderBottom: "1px solid var(--app-border-1)",
            borderLeft: `3px solid ${accentColor}`,
          }}>
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl"
              style={{ background: accentSoft, border: `1px solid ${accentBorder}` }}>
              {isEdit
                ? <Settings2 style={{ width: 16, height: 16, color: accentColor }} />
                : <Bot       style={{ width: 16, height: 16, color: accentColor }} />}
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-extrabold tracking-tight" style={{ color: "var(--app-text-bright)" }}>
                {isEdit ? "Bot Filters" : "Configure Bot"}
              </span>
              <span className="text-[10px]" style={{ color: "var(--app-text-dimmer)" }}>
                {isEdit ? "Adjust running filter thresholds" : "Set criteria and launch the trading bot"}
              </span>
            </div>
          </div>
          <button onClick={onCancel}
            className="flex items-center justify-center w-7 h-7 rounded-lg"
            style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-1)", cursor: "pointer" }}>
            <X style={{ width: 13, height: 13, color: "var(--app-text-muted)" }} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex flex-col gap-4 p-4 sm:p-5 overflow-y-auto" style={{ flex: "1 1 0%", minHeight: 0 }}>

          {/* ── SECTION 1: Opportunity Filters ── */}
          <div className="flex flex-col gap-3">
            <SectionHeader color="#60a5fa" label="Opportunity Filters" />

            {/* Row 1: Net Profit + Times Hit */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <FieldInput
                label="Min Net Profit (≥)"
                value={form.minNetProfitPct}
                onChange={set("minNetProfitPct")}
                step={0.1} min={0} suffix="%"
                hint="live opp filter + times-hit target"
              />
              <FieldInput
                label="Min Times Hit (≥)"
                value={form.minTimesHit}
                onChange={set("minTimesHit")}
                step={1} min={0} suffix="×"
                hint="in 4H window"
              />
            </div>

            {/* Row 2: Movement + Withdraw Fee */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3 [&>*]:w-full">
              <MovementInput
                value={form.maxMovementPct}
                onChange={set("maxMovementPct")}
                window={form.priceMovementWindow}
                onWindowChange={set("priceMovementWindow")}
              />
              <FieldInput
                label="Max Withdraw Fee (≤)"
                value={form.maxWithdrawFeeUSD}
                onChange={set("maxWithdrawFeeUSD")}
                step={0.5} min={0} suffix="$"
                hint="0 = no cap"
              />
            </div>

            {/* Row 3: Address Verified toggle */}
            <ToggleRow
              label="Require Verified Address"
              hint="Only trade pairs where contract address is confirmed on both exchanges"
              checked={form.requireAddressVerified}
              onChange={setBool("requireAddressVerified")}
            />
          </div>

          {/* ── SECTION 2: Trade Settings ── */}
          <div className="flex flex-col gap-3">
            <SectionHeader color="var(--app-success)" label="Trade Settings" />
            <div className="grid grid-cols-3 gap-2">
              <FieldInput
                label="Trade Amount"
                value={form.tradeAmountUSDT}
                onChange={set("tradeAmountUSDT")}
                step={10} min={1} suffix="USDT"
              />
              <FieldInput
                label="Required Profit (≥)"
                value={form.takeProfitPct}
                onChange={set("takeProfitPct")}
                step={0.1} min={0} suffix="%"
                hint="sell trigger"
              />
              <FieldInput
                label="Max Open Positions"
                value={form.maxOpenPositions}
                onChange={set("maxOpenPositions")}
                step={1} min={1} suffix="pos"
                hint="concurrent"
              />
            </div>
          </div>

          {/* ── SECTION 3: Allowed Exchanges ── */}
          <div className="flex flex-col gap-2.5">
            <SectionHeader color="var(--app-warning)" label="Allowed Exchanges" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ALL_EXCHANGES.map((ex, i) => {
                const active = form.allowedExchanges.includes(ex);
                return (
                  <button key={ex} onClick={() => toggleEx(ex)}
                    className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl"
                    style={{
                      background:  active ? "var(--app-success-soft)" : "var(--app-surface-2)",
                      color:       active ? "var(--app-success)"       : "var(--app-text-dimmer)",
                      border:      `1px solid ${active ? "var(--app-success-border)" : "var(--app-border-1)"}`,
                      cursor:      "pointer",
                      boxShadow:   active ? "0 0 14px var(--app-success-soft), 0 2px 8px rgba(0,0,0,0.25)" : "0 2px 4px rgba(0,0,0,0.15)",
                      transform:   active ? "scale(1.04)" : "scale(1)",
                      transition:  "all 0.2s cubic-bezier(0.34,1.56,0.64,1)",
                      animation:   `exchange-chip-in 0.28s cubic-bezier(0.34,1.56,0.64,1) ${i * 55}ms both`,
                    }}>
                    <div style={{ filter: active ? "none" : "grayscale(0.6) opacity(0.65)", transition: "filter 0.2s ease" }}>
                      <ExchangeIcon name={ex} size={26} />
                    </div>
                    <span className="text-[9px] font-extrabold uppercase tracking-widest">{ex}</span>
                    <span style={{
                      width: 5, height: 5, borderRadius: "50%",
                      background: active ? "var(--app-success)" : "var(--app-border-1)",
                      display: "block", transition: "background 0.2s",
                    }} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Footer actions ── */}
        <div className="px-4 pb-4 sm:px-5 sm:pb-5 flex gap-2.5 flex-shrink-0">
          {isEdit ? (
            <button
              onClick={() => handleStart()}
              className="flex-1 h-11 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
              style={{ background: "var(--app-success)", color: "#fff", cursor: "pointer", border: "none",
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)" }}>
              <CheckCircle2 style={{ width: 15, height: 15 }} />
              Save Filters
            </button>
          ) : (
            <button
              onClick={() => handleStart()}
              className="flex-1 h-11 rounded-xl text-sm font-extrabold flex items-center justify-center gap-2"
              style={{
                background: "linear-gradient(135deg, #dc2626 0%, #ef4444 45%, #f97316 100%)",
                color: "#fff", border: "none", cursor: "pointer",
                boxShadow: "0 4px 18px rgba(239,68,68,0.45), 0 2px 8px rgba(0,0,0,0.35)",
                position: "relative", overflow: "hidden", letterSpacing: "0.04em",
              }}>
              <span style={{
                position: "absolute", inset: 0,
                background: "linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.28) 50%, transparent 70%)",
                animation: "go-live-shimmer 2.2s ease-in-out infinite",
                pointerEvents: "none",
              }} />
              <Zap style={{
                width: 16, height: 16,
                animation: "go-live-zap 1.8s ease-in-out infinite",
                filter: "drop-shadow(0 0 4px rgba(255,220,100,0.9))",
                flexShrink: 0,
              }} />
              <span style={{ position: "relative" }}>Go Live</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main BotPanel ─────────────────────────────────────────────────────────────

export function BotPanel() {
  const [now,         setNow]         = useState(() => Date.now());
  const [showPopup,   setShowPopup]   = useState(false);
  const [popupMode,   setPopupMode]   = useState("start"); // "start" | "edit"
  const qc = useQueryClient();

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const { data: status, isLoading } = useQuery({
    queryKey:        ["bot-status"],
    queryFn:         async () => {
      const r = await fetch("/api/bot/status");
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
    refetchInterval: 5_000,
    staleTime:       4_000,
  });

  const configMut = useMutation({
    mutationFn: async (patch) => {
      const r = await fetch("/api/bot/config", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: (data) => {
      qc.setQueryData(["bot-status"], (old) => old ? { ...old, config: data } : old);
    },
  });

  const cfg       = status?.config ?? {};
  const isEnabled = cfg.enabled  ?? false;
  const isBusy    = configMut.isPending || isLoading;

  const headerColor = isEnabled ? "var(--app-success)" : "var(--app-text-muted)";
  const borderColor = isEnabled ? "var(--app-success-border)" : "var(--app-border-0)";
  const headerBg    = isEnabled ? "var(--app-success-soft)" : "var(--app-surface-1)";

  // When user flips ON: show popup to configure
  const handleToggle = (wantEnabled) => {
    if (wantEnabled && !isEnabled) {
      setPopupMode("start");
      setShowPopup(true);
    } else {
      configMut.mutate({ enabled: false });
    }
  };

  const handleConfirm = useCallback((fullConfig) => {
    configMut.mutate(fullConfig);
    setShowPopup(false);
  }, [configMut]);

  const handleCancel = useCallback(() => {
    setShowPopup(false);
  }, []);

  return (
    <>
      {/* ── Filter popup ── */}
      {showPopup && (
        <FilterPopup
          currentCfg={cfg}
          mode={popupMode}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}

      <div className="rounded-xl flex flex-col gap-3 p-4"
        style={{ background: headerBg, border: `1px solid ${borderColor}`, transition: "all 0.3s" }}>

        {/* ── Header row ── */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {isEnabled
              ? <Zap    style={{ width: 15, height: 15, color: headerColor }} />
              : <BotOff style={{ width: 15, height: 15, color: headerColor }} />
            }
            <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: headerColor }}>
              Trading Bot
            </span>

            {isEnabled && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full animate-pulse"
                style={{ background: "var(--app-success-soft)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}>
                LIVE
              </span>
            )}
            {!isEnabled && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: "var(--app-surface-2)", color: "var(--app-text-dimmer)", border: "1px solid var(--app-border-1)" }}>
                OFF
              </span>
            )}
            {isEnabled && (status?.tradesThisHour ?? 0) > 0 && (
              <span className="text-[9px] font-mono flex items-center gap-1" style={{ color: "var(--app-text-dimmer)" }}>
                <Clock style={{ width: 9, height: 9 }} />
                {status?.tradesThisHour ?? 0} trade{(status?.tradesThisHour ?? 0) !== 1 ? "s" : ""} this hr
              </span>
            )}
          </div>

          {/* Right side controls */}
          <div className="flex items-center gap-3">
            {/* Edit filters button (when running) */}
            {isEnabled && (
              <button onClick={() => { setPopupMode("edit"); setShowPopup(true); }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-widest"
                style={{ background: "var(--app-surface-2)", color: "var(--app-text-muted)",
                  border: "1px solid var(--app-border-1)", cursor: "pointer" }}>
                <Settings2 style={{ width: 11, height: 11 }} />
                Filters
              </button>
            )}

            {/* Main ON/OFF toggle */}
            <Toggle
              checked={isEnabled}
              onChange={handleToggle}
              disabled={isBusy}
              color="var(--app-success)"
            />
          </div>
        </div>

        {/* ── Live warning ── */}
        {isEnabled && (
          <div className="flex items-center gap-2 rounded-lg px-3 py-2"
            style={{ background: "var(--app-danger-soft)", border: "1px solid var(--app-danger-border)" }}>
            <Zap style={{ width: 12, height: 12, color: "var(--app-danger)", flexShrink: 0 }} />
            <span className="text-[10px]" style={{ color: "var(--app-danger)" }}>
              Live trading active — real orders will be placed.
            </span>
          </div>
        )}

        {/* ── Active filter summary (when bot is running) ── */}
        {isEnabled && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {[
              { label: "Trade Amt",      val: `$${cfg.tradeAmountUSDT ?? 100}`,   col: "var(--app-warning)" },
              { label: "Min Times Hit",  val: `${cfg.minTimesHit ?? 3}×`,         col: "var(--app-text-muted)" },
              { label: "Target Profit",  val: `${cfg.minNetProfitPct ?? 1}%`,     col: "var(--app-success)" },
              { label: "Take Profit",    val: `${cfg.takeProfitPct ?? 1}%`,       col: "var(--app-success)" },
              { label: "Max Positions",  val: `${cfg.maxOpenPositions ?? 1}`,     col: "var(--app-text-muted)" },
            ].map(({ label, val, col }) => (
              <div key={label} className="flex items-center gap-1">
                <span className="text-[9px] uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>{label}:</span>
                <span className="text-[9px] font-bold font-mono" style={{ color: col }}>{val}</span>
              </div>
            ))}

            {/* Exchange chips */}
            <div className="flex items-center gap-1 flex-wrap">
              {(cfg.allowedExchanges ?? ALL_EXCHANGES).map((ex) => (
                <span key={ex} className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded-full"
                  style={{ background: "var(--app-success-soft)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}>
                  {ex}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Active trade card ── */}
        {activeTrade && (
          <ActiveTradeCard trade={activeTrade} now={now} />
        )}

      </div>
    </>
  );
}
