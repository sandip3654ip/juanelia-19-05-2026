import { useState, useEffect, useRef, useCallback } from "react";
import {
  Scale, Play, Square, RefreshCw,
  AlertTriangle, CheckCircle, Clock, Zap, BellRing, ListOrdered,
  TrendingUp, ArrowRight, Copy, Check,
} from "lucide-react";

const EXCHANGES = ["binance", "kucoin", "bybit", "bitget"];
const EXCHANGE_COLORS = {
  binance: "#F0B90B",
  kucoin:  "#24AE8F",
  bybit:   "#F7A600",
  bitget:  "#00C4C4",
};

const API = "/api/spot-hedge";

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Phase badge ─────────────────────────────────────────────────────────────
function PhaseBadge({ phase }) {
  const map = {
    idle:       { label: "IDLE",       color: "var(--app-text-dim)",   bg: "var(--app-surface-1)" },
    watching:   { label: "WATCHING",   color: "#60a5fa",               bg: "rgba(96,165,250,0.12)" },
    harvesting: { label: "HARVESTING", color: "var(--app-success)",    bg: "var(--app-success-soft)" },
    exiting:    { label: "EXITING",    color: "#f59e0b",               bg: "rgba(245,158,11,0.12)" },
    stopped:    { label: "COMPLETE",   color: "var(--app-text-muted)", bg: "var(--app-surface-1)" },
  };
  const { label, color, bg } = map[phase] ?? map.idle;
  return (
    <span
      className="text-[10px] font-bold tracking-widest px-2 py-0.5 rounded"
      style={{ color, background: bg, border: `1px solid ${color}40` }}
    >
      {label}
    </span>
  );
}

// ── Inventory bar ────────────────────────────────────────────────────────────
function InventoryBar({ inv, cfg }) {
  if (!inv || !cfg) return null;
  return (
    <div className="grid grid-cols-2 gap-3">
      {[{ key: "a", label: cfg.exchangeA }, { key: "b", label: cfg.exchangeB }].map(({ key, label }) => {
        const side = inv[key];
        const col  = EXCHANGE_COLORS[label] ?? "var(--app-success)";
        return (
          <div
            key={key}
            className="rounded-lg p-3 flex flex-col gap-2"
            style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}
          >
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full" style={{ background: col }} />
              <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: col }}>
                {label}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center">
                <span className="text-[10px]" style={{ color: "var(--app-text-dim)" }}>USDT</span>
                <span className="text-xs font-mono font-bold" style={{ color: "var(--app-text-primary)" }}>
                  ${side.usdt.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px]" style={{ color: "var(--app-text-dim)" }}>{cfg.token}</span>
                <span className="text-xs font-mono font-bold" style={{ color: "var(--app-success)" }}>
                  {side.token.toFixed(4)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Live Monitoring Panel ─────────────────────────────────────────────────────
function LiveMonitor({ cfg }) {
  const [quotes, setQuotes] = useState(null);
  const timerRef = useRef(null);

  const fetchQuotes = useCallback(async () => {
    if (!cfg) return;
    try {
      const q = await apiFetch(
        `${API}/quotes?token=${cfg.token}&exchangeA=${cfg.exchangeA}&exchangeB=${cfg.exchangeB}` +
        `&tdsPct=${cfg.tdsPct}&takerFeePct=${cfg.takerFeePct}&gstPct=${cfg.gstPct ?? 18}&tradeAmountUsdt=${cfg.tradeAmountUsdt}`,
      );
      setQuotes(q);
    } catch { /* silent */ }
  }, [cfg]);

  useEffect(() => {
    fetchQuotes();
    timerRef.current = setInterval(fetchQuotes, 1_000);
    return () => clearInterval(timerRef.current);
  }, [fetchQuotes]);

  if (!cfg || !quotes) return null;

  const net    = quotes.netProfitPct;
  const target = cfg.minSpreadPct;
  const pct    = net == null ? 0 : Math.min(100, Math.max(0, (net / target) * 100));
  const hit    = net != null && net >= target;
  const dir    = quotes.direction;

  const sellEx = dir === "sell_A_buy_B" ? cfg.exchangeA : cfg.exchangeB;
  const buyEx  = dir === "sell_A_buy_B" ? cfg.exchangeB : cfg.exchangeA;
  const bidPx  = dir === "sell_A_buy_B" ? quotes.bidA   : quotes.bidB;
  const askPx  = dir === "sell_A_buy_B" ? quotes.askB   : quotes.askA;

  const rawSpread = (bidPx != null && askPx != null && askPx > 0)
    ? ((bidPx - askPx) / askPx) * 100
    : null;
  const effFeePct = cfg.takerFeePct * (1 + (cfg.gstPct ?? 18) / 100);
  const tdsCost  = rawSpread != null ? cfg.tdsPct              : null;
  const feesCost = rawSpread != null ? (effFeePct * 2)         : null;

  const fmtPx = (v) => v == null ? "—" : v < 0.01 ? v.toFixed(6) : v < 1 ? v.toFixed(4) : v.toFixed(3);
  const fmtPct = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`;

  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3"
      style={{
        background: "var(--app-bg)",
        border: `1px solid ${hit ? "rgba(74,222,128,0.4)" : "var(--app-border-0)"}`,
      }}
    >
      <div className="flex items-center gap-2">
        <TrendingUp className="h-3.5 w-3.5" style={{ color: hit ? "var(--app-success)" : "var(--app-text-dim)" }} />
        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>
          Live Flip Monitor
        </span>
        {hit && (
          <span className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded"
            style={{ background: "var(--app-success-soft)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}>
            FLIP READY
          </span>
        )}
      </div>

      {/* Price row */}
      <div className="flex items-center gap-2">
        <div className="flex-1 rounded-lg px-3 py-2 flex flex-col gap-0.5"
          style={{ background: "var(--app-surface-1)", border: "1px solid rgba(248,113,113,0.2)" }}>
          <div className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "#f87171" }}>
            SELL · {sellEx}
          </div>
          <div className="text-sm font-black font-mono" style={{ color: "#f87171" }}>{fmtPx(bidPx)}</div>
          <div className="text-[9px]" style={{ color: "var(--app-text-dim)" }}>Bid</div>
        </div>
        <ArrowRight className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--app-text-muted)" }} />
        <div className="flex-1 rounded-lg px-3 py-2 flex flex-col gap-0.5"
          style={{ background: "var(--app-surface-1)", border: "1px solid rgba(74,222,128,0.2)" }}>
          <div className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "#4ade80" }}>
            BUY · {buyEx}
          </div>
          <div className="text-sm font-black font-mono" style={{ color: "#4ade80" }}>{fmtPx(askPx)}</div>
          <div className="text-[9px]" style={{ color: "var(--app-text-dim)" }}>Ask</div>
        </div>
      </div>

      {/* Calculation breakdown */}
      <div className="flex flex-col gap-1.5 text-xs">
        {[
          { label: "Raw Spread",    value: fmtPct(rawSpread),            color: "var(--app-text-primary)" },
          { label: `TDS (${cfg.tdsPct}% sell)`,               value: rawSpread != null ? `−${tdsCost.toFixed(3)}%`  : "—", color: "#f87171" },
          { label: `Fees (${effFeePct.toFixed(3)}%×2 incl. GST)`, value: rawSpread != null ? `−${feesCost.toFixed(3)}%` : "—", color: "#f87171" },
        ].map(({ label, value, color }) => (
          <div key={label} className="flex items-center justify-between">
            <span style={{ color: "var(--app-text-dim)" }}>{label}</span>
            <span className="font-mono font-bold" style={{ color }}>{value}</span>
          </div>
        ))}
        <div className="flex items-center justify-between pt-1"
          style={{ borderTop: "1px solid var(--app-border-0)" }}>
          <span className="font-bold uppercase tracking-widest text-[10px]" style={{ color: "var(--app-text-muted)" }}>Net Profit</span>
          <span className="font-black font-mono text-sm"
            style={{ color: hit ? "var(--app-success)" : net != null && net > 0 ? "#facc15" : "var(--app-text-muted)" }}>
            {fmtPct(net)}
          </span>
        </div>
      </div>

      {/* Progress bar toward target */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-[9px]" style={{ color: "var(--app-text-dim)" }}>
          <span>0%</span>
          <span>Target: {target}%</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--app-surface-2)" }}>
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${pct}%`,
              background: hit
                ? "var(--app-success)"
                : pct > 60
                  ? "#facc15"
                  : "var(--app-text-dim)",
            }}
          />
        </div>
        <div className="text-[9px] text-right font-mono" style={{ color: "var(--app-text-dim)" }}>
          {pct.toFixed(0)}% of target
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BOT TAB
// ─────────────────────────────────────────────────────────────────────────────
function BotPane({ botState, onRefresh }) {
  const [token,        setToken]        = useState("BTC");
  const [exchA,        setExchA]        = useState("binance");
  const [exchB,        setExchB]        = useState("kucoin");
  const [amtUsdt,      setAmtUsdt]      = useState(100);
  const [targetNet,    setTargetNet]    = useState(0.5);
  const [maxSpread,    setMaxSpread]    = useState(1.5);
  const [countTrades,  setCountTrades]  = useState(1);
  const [tdsPct,       setTdsPct]       = useState(1);
  const [feePct,       setFeePct]       = useState(0.1);
  const [flipInterval, setFlipInterval] = useState(30);
  const [maxLossUsdt,  setMaxLossUsdt]  = useState(5);
  const [dryRun,       setDryRun]       = useState(true);
  const [loading,    setLoading]    = useState(false);
  const [msg,        setMsg]        = useState(null);

  const isRunning = botState && !["idle", "stopped"].includes(botState.phase);

  async function handleStart() {
    setLoading(true); setMsg(null);
    try {
      await apiFetch(`${API}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token, exchangeA: exchA, exchangeB: exchB,
          tradeAmountUsdt:     amtUsdt,
          minSpreadPct:        targetNet,
          neutralThresholdPct: maxSpread,
          maxRounds:           countTrades,
          tdsPct, takerFeePct: feePct, gstPct: 18,
          flipIntervalSec:     flipInterval,
          maxLossUsdt:         maxLossUsdt,
          dryRun,
        }),
      });
      setMsg({ ok: true, text: `Bot started (${dryRun ? "DRY RUN" : "LIVE"})` });
      onRefresh();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally     { setLoading(false); }
  }

  async function handleStop(force = false) {
    setLoading(true); setMsg(null);
    try {
      await apiFetch(`${API}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      setMsg({ ok: true, text: force ? "Force stopped" : "Exit initiated" });
      onRefresh();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally     { setLoading(false); }
  }

  const state = botState;
  const cfg   = state?.config;
  const inv   = state?.inventory;

  return (
    <div className="flex flex-col gap-4 p-4 max-w-3xl mx-auto w-full">

      {/* Config form — shown only when idle (not yet started) */}
      {(!botState || botState.phase === "idle") && (
        <div
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Scale className="h-4 w-4" style={{ color: "var(--app-success)" }} />
            <span className="text-sm font-bold" style={{ color: "var(--app-text-bright)" }}>Configure Hedge Bot</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              ["Token",                  token,       setToken,        "text",   null, "GOD / BTC"],
              ["Exchange A",             exchA,       setExchA,        "select", null, null],
              ["Exchange B",             exchB,       setExchB,        "select", null, null],
              ["Trade USDT",             amtUsdt,     setAmtUsdt,      "number", 10,   "100"],
              ["Target Net Profit %",    targetNet,   setTargetNet,    "number", 0.01, "0.5"],
              ["Entry/Exit Spread Max",  maxSpread,   setMaxSpread,    "number", 0.1,  "1.5"],
              ["Count Of Trades",        countTrades, setCountTrades,  "number", 1,    "1"],
              ["TDS %",                  tdsPct,      setTdsPct,       "number", 0,    "1"],
              ["Taker Fee %",            feePct,      setFeePct,       "number", 0.01, "0.1"],
              ["Flip Cooldown (sec)",    flipInterval,setFlipInterval, "number", 0,    "30"],
              ["Max Loss USDT (0=off)",  maxLossUsdt, setMaxLossUsdt,  "number", 0,    "5"],
            ].map(([lbl, val, setter, type, min, ph]) => (
              <div key={lbl} className="flex flex-col gap-1">
                <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>{lbl}</label>
                {type === "select" ? (
                  <select
                    value={val}
                    onChange={e => setter(e.target.value)}
                    className="px-2 py-1.5 text-xs rounded-md outline-none capitalize"
                    style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-1)", color: "var(--app-text-primary)" }}
                  >
                    {EXCHANGES.map(ex => <option key={ex} value={ex}>{ex}</option>)}
                  </select>
                ) : (
                  <input
                    type={type}
                    value={val}
                    onChange={e => setter(type === "number" ? Number(e.target.value) : e.target.value.toUpperCase())}
                    placeholder={ph}
                    min={min}
                    step={type === "number" ? (min ?? 1) : undefined}
                    className="px-2 py-1.5 text-xs font-mono rounded-md outline-none"
                    style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-1)", color: "var(--app-text-primary)" }}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Dry run toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <div
              onClick={() => setDryRun(!dryRun)}
              className="w-10 h-5 rounded-full relative transition-colors cursor-pointer"
              style={{ background: dryRun ? "var(--app-success)" : "var(--app-surface-2)" }}
            >
              <div
                className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
                style={{ left: dryRun ? "calc(100% - 18px)" : "2px" }}
              />
            </div>
            <span className="text-xs font-semibold" style={{ color: dryRun ? "var(--app-success)" : "var(--app-text-dim)" }}>
              {dryRun ? "DRY RUN (simulated)" : "LIVE TRADING"}
            </span>
          </label>

          {msg && (
            <div
              className="text-xs px-3 py-2 rounded-lg flex items-center gap-2"
              style={{
                background: msg.ok ? "var(--app-success-soft)" : "rgba(248,113,113,0.1)",
                color:      msg.ok ? "var(--app-success)"      : "#f87171",
                border:     `1px solid ${msg.ok ? "var(--app-success-border)" : "rgba(248,113,113,0.3)"}`,
              }}
            >
              {msg.ok ? <CheckCircle className="h-3.5 w-3.5 flex-shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />}
              {msg.text}
            </div>
          )}

          <button
            onClick={handleStart}
            disabled={loading || !token.trim() || exchA === exchB}
            className="w-full py-2.5 text-sm font-bold rounded-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50"
            style={{ background: "var(--app-success)", color: "#000" }}
          >
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Start Bot {dryRun ? "(Dry Run)" : "(Live)"}
          </button>
        </div>
      )}

      {/* Running state */}
      {isRunning && cfg && (
        <div className="flex flex-col gap-4">
          <div
            className="rounded-xl p-4 flex items-center justify-between gap-3"
            style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-success-border)" }}
          >
            <div className="flex items-center gap-3">
              <Zap className="h-5 w-5 flex-shrink-0" style={{ color: "var(--app-success)" }} />
              <div>
                <div className="text-sm font-bold" style={{ color: "var(--app-text-bright)" }}>
                  {cfg.token} · {cfg.exchangeA} ↔ {cfg.exchangeB}
                </div>
                <div className="text-[10px]" style={{ color: "var(--app-text-dim)" }}>
                  {cfg.dryRun ? "DRY RUN" : "LIVE"} · {cfg.tradeAmountUsdt} USDT/round
                </div>
              </div>
            </div>
            <PhaseBadge phase={state.phase} />
          </div>

          {/* Status message */}
          <div
            className="text-xs px-3 py-2 rounded-lg"
            style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)", color: "var(--app-text-muted)" }}
          >
            {state.statusMessage}
          </div>

          {/* Live Flip Monitor — only in harvesting phase */}
          {state.phase === "harvesting" && <LiveMonitor cfg={cfg} />}

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Net Profit",    value: `${state.totalNetProfit >= 0 ? "+" : ""}${state.totalNetProfit.toFixed(4)} USDT`, color: state.totalNetProfit >= 0 ? "var(--app-success)" : "#f87171" },
              { label: "Rounds",        value: cfg.maxRounds > 0 ? `${state.roundCount}/${cfg.maxRounds}` : state.roundCount, color: "var(--app-text-primary)" },
              { label: "Target Net %",  value: `${cfg.minSpreadPct}%`, color: "var(--app-text-muted)" },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-lg p-3" style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}>
                <div className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: "var(--app-text-dim)" }}>{label}</div>
                <div className="text-sm font-black font-mono" style={{ color }}>{value}</div>
              </div>
            ))}
          </div>

          {inv && <InventoryBar inv={inv} cfg={cfg} />}

          {/* Errors / compensation events log */}
          {state.errors?.length > 0 && (
            <div
              className="rounded-xl p-3 flex flex-col gap-1.5"
              style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.2)" }}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <AlertTriangle className="h-3 w-3" style={{ color: "#f87171" }} />
                <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "#f87171" }}>Events / Errors</span>
                {state.lastSyncAt && (
                  <span className="ml-auto text-[9px]" style={{ color: "var(--app-text-dim)" }}>
                    Synced {new Date(state.lastSyncAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
              {[...state.errors].reverse().slice(0, 5).map((e, i) => (
                <div key={i} className="flex gap-2 text-[10px]">
                  <span className="flex-shrink-0 font-mono" style={{ color: "var(--app-text-dim)" }}>
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                  <span style={{ color: "#fca5a5" }}>{e.msg}</span>
                </div>
              ))}
            </div>
          )}

          {msg && (
            <div
              className="text-xs px-3 py-2 rounded-lg flex items-center gap-2"
              style={{
                background: msg.ok ? "var(--app-success-soft)" : "rgba(248,113,113,0.1)",
                color:      msg.ok ? "var(--app-success)"      : "#f87171",
                border:     `1px solid ${msg.ok ? "var(--app-success-border)" : "rgba(248,113,113,0.3)"}`,
              }}
            >
              {msg.ok ? <CheckCircle className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {msg.text}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => handleStop(false)}
              disabled={loading}
              className="flex-1 py-2 text-sm font-bold rounded-lg flex items-center justify-center gap-2"
              style={{ background: "rgba(245,158,11,0.1)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)" }}
            >
              <Clock className="h-4 w-4" /> Graceful Exit
            </button>
            <button
              onClick={() => handleStop(true)}
              disabled={loading}
              className="flex-1 py-2 text-sm font-bold rounded-lg flex items-center justify-center gap-2"
              style={{ background: "rgba(248,113,113,0.1)", color: "#f87171", border: "1px solid rgba(248,113,113,0.3)" }}
            >
              <Square className="h-4 w-4" /> Force Stop
            </button>
          </div>
        </div>
      )}

      {/* Completed state */}
      {state?.phase === "stopped" && (
        <div
          className="rounded-xl p-5 flex flex-col gap-3 items-center text-center"
          style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}
        >
          <CheckCircle className="h-8 w-8" style={{ color: "var(--app-success)" }} />
          <div className="text-sm font-bold" style={{ color: "var(--app-text-bright)" }}>Cycle Complete</div>
          <div
            className="text-2xl font-black font-mono"
            style={{ color: (state.totalNetProfit ?? 0) >= 0 ? "var(--app-success)" : "#f87171" }}
          >
            {(state.totalNetProfit ?? 0) >= 0 ? "+" : ""}{(state.totalNetProfit ?? 0).toFixed(4)} USDT
          </div>
          <div className="text-xs" style={{ color: "var(--app-text-dim)" }}>
            {state.roundCount} rounds · {state.trades.length} trades
          </div>
          {msg && (
            <div className="text-xs" style={{ color: msg.ok ? "var(--app-success)" : "#f87171" }}>{msg.text}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADES TAB
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_META = {
  init:    { label: "INIT",    color: "#60a5fa", bg: "rgba(96,165,250,0.12)",  icon: "→" },
  harvest: { label: "HARVEST", color: "#4ade80", bg: "rgba(74,222,128,0.12)",  icon: "⇄" },
  exit:    { label: "EXIT",    color: "#f59e0b", bg: "rgba(245,158,11,0.12)",  icon: "←" },
};

const EXCHANGE_LOGOS = {
  binance: "https://assets.coingecko.com/markets/images/52/small/binance.jpg",
  kucoin:  "https://assets.coingecko.com/markets/images/61/small/kucoin.jpg",
  bybit:   "https://assets.coingecko.com/markets/images/698/small/bybit_spot.jpg",
  bitget:  "https://assets.coingecko.com/markets/images/951/small/bitget.jpg",
};

function ExPill({ name }) {
  if (!name) return <span style={{ color: "var(--app-text-dim)" }}>—</span>;
  const col  = EXCHANGE_COLORS[name] ?? "#888";
  const logo = EXCHANGE_LOGOS[name];
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold uppercase"
      style={{ background: col + "22", color: col, border: `1px solid ${col}55` }}>
      {logo && (
        <img src={logo} alt={name}
          className="rounded-full flex-shrink-0"
          style={{ width: 14, height: 14, objectFit: "cover" }}
          onError={e => { e.currentTarget.style.display = "none"; }}
        />
      )}
      {name}
    </span>
  );
}

function fmtPx(v) {
  if (v == null) return "—";
  if (v >= 1000) return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (v >= 1)    return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

function fmtDur(ms) {
  if (!ms || ms < 0) return "0m";
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60)  return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function StepCard({ t, stepNum, totalSteps, cumulative, token, cfg }) {
  const meta      = TYPE_META[t.tradeType] ?? TYPE_META.harvest;
  const isHarvest = t.tradeType === "harvest";
  const isInit    = t.tradeType === "init";
  const isExit    = t.tradeType === "exit";
  const netColor  = t.netProfit >= 0 ? "#4ade80" : "#f87171";
  const cumColor  = cumulative >= 0 ? "#4ade80" : "#f87171";
  const isLast    = stepNum === totalSteps;

  const exALabel  = cfg?.exchangeA ?? "A";
  const exBLabel  = cfg?.exchangeB ?? "B";

  return (
    <div className="flex gap-4">
      {/* ── Step indicator (left rail) ── */}
      <div className="flex flex-col items-center flex-shrink-0" style={{ width: 40 }}>
        <div className="flex items-center justify-center rounded-full w-10 h-10 font-black text-sm"
          style={{ background: meta.bg, border: `2px solid ${meta.color}`, color: meta.color, flexShrink: 0 }}>
          {isInit ? "I" : isExit ? "E" : stepNum}
        </div>
        {!isLast && (
          <div className="flex-1 w-0.5 my-1" style={{ background: "var(--app-border-1)", minHeight: 24 }} />
        )}
      </div>

      {/* ── Card (right) ── */}
      <div className="flex-1 rounded-2xl overflow-hidden mb-4"
        style={{ border: `1px solid ${meta.color}44` }}>

        {/* Card header */}
        <div className="flex items-center justify-between px-4 py-3"
          style={{ background: meta.bg, borderBottom: `1px solid ${meta.color}30` }}>
          <div className="flex items-center gap-3">
            <span className="text-sm font-black uppercase tracking-wide" style={{ color: meta.color }}>
              {isInit ? "Init Buy" : isExit ? "Exit Sell" : `Round ${t.roundNum} — Harvest Flip`}
            </span>
          </div>
          <span className="text-xs font-mono" style={{ color: "var(--app-text-dim)" }}>
            {new Date(t.timestamp).toLocaleTimeString()}
          </span>
        </div>

        <div className="p-4 flex flex-col gap-4" style={{ background: "var(--app-surface-1)" }}>

          {/* ── Exchange route ── */}
          {isHarvest && (
            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#f87171" }}>Sell on</span>
                <ExPill name={t.sellExchange} />
              </div>
              <div className="flex flex-col items-center gap-0.5 px-2">
                <div className="text-lg" style={{ color: "var(--app-text-dim)" }}>→</div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#4ade80" }}>Buy on</span>
                <ExPill name={t.buyExchange} />
              </div>
            </div>
          )}
          {isInit && (
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: "var(--app-text-dim)" }}>Initial buy on</span>
              <ExPill name={t.buyExchange} />
            </div>
          )}
          {isExit && (
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: "var(--app-text-dim)" }}>Exit sell on</span>
              <ExPill name={t.sellExchange} />
            </div>
          )}

          {/* ── Prices & Qty ── */}
          <div className="grid grid-cols-3 gap-3">
            {isHarvest && (
              <>
                <div className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
                  style={{ background: "rgba(248,113,113,0.07)", border: "1px solid rgba(248,113,113,0.2)" }}>
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#f87171" }}>Sell Price</span>
                  <span className="text-base font-black font-mono" style={{ color: "#f87171" }}>{fmtPx(t.sellPrice)}</span>
                </div>
                <div className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
                  style={{ background: "rgba(74,222,128,0.07)", border: "1px solid rgba(74,222,128,0.2)" }}>
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#4ade80" }}>Buy Price</span>
                  <span className="text-base font-black font-mono" style={{ color: "#4ade80" }}>{fmtPx(t.buyPrice)}</span>
                </div>
              </>
            )}
            {(isInit || isExit) && (
              <div className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
                style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)" }}>
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>
                  {isInit ? "Buy Price" : "Sell Price"}
                </span>
                <span className="text-base font-black font-mono" style={{ color: "var(--app-text-primary)" }}>
                  {fmtPx(isInit ? t.buyPrice : t.sellPrice)}
                </span>
              </div>
            )}
            <div className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
              style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)" }}>
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Quantity</span>
              <span className="text-base font-black font-mono" style={{ color: "var(--app-text-primary)" }}>
                {t.qty.toFixed(4)} <span className="text-sm font-bold" style={{ color: "var(--app-text-dim)" }}>{token}</span>
              </span>
            </div>
          </div>

          {/* ── P&L breakdown ── */}
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--app-border-0)" }}>
            <div className="grid grid-cols-4 divide-x" style={{ borderColor: "var(--app-border-0)" }}>
              {[
                { label: "Gross Profit", value: t.grossProfit > 0 ? `+${t.grossProfit.toFixed(4)}` : t.grossProfit.toFixed(4), color: "var(--app-text-primary)" },
                { label: `TDS (${cfg?.tdsPct ?? 1}%)`,     value: `−${t.tdsUsdt.toFixed(4)}`,   color: "#f87171" },
                { label: "Fees",         value: `−${t.feesUsdt.toFixed(4)}`,  color: "#fb923c" },
                { label: "Net Profit",   value: `${t.netProfit >= 0 ? "+" : ""}${t.netProfit.toFixed(4)}`, color: netColor, bold: true },
              ].map(({ label, value, color, bold }) => (
                <div key={label} className="flex flex-col gap-1 px-3 py-2.5"
                  style={{ background: bold ? (t.netProfit >= 0 ? "rgba(74,222,128,0.07)" : "rgba(248,113,113,0.07)") : "var(--app-surface-1)" }}>
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>{label}</span>
                  <span className={`font-mono ${bold ? "text-base font-black" : "text-sm font-bold"}`} style={{ color }}>
                    {value} <span className="text-[10px] font-normal" style={{ color: "var(--app-text-dim)" }}>USDT</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Inventory after ── */}
          {t.inventoryAfter && (
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>
                Inventory after this step
              </span>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: exALabel, data: t.inventoryAfter.a, col: EXCHANGE_COLORS[exALabel] ?? "#888" },
                  { label: exBLabel, data: t.inventoryAfter.b, col: EXCHANGE_COLORS[exBLabel] ?? "#888" },
                ].map(({ label, data, col }) => (
                  <div key={label} className="rounded-xl px-4 py-3 flex flex-col gap-2"
                    style={{ background: "var(--app-bg)", border: `1px solid ${col}33` }}>
                    <span className="text-xs font-bold uppercase" style={{ color: col }}>{label}</span>
                    <div className="flex items-center justify-between">
                      <span className="text-xs" style={{ color: "var(--app-text-dim)" }}>{token}</span>
                      <span className="text-sm font-black font-mono" style={{ color: data.token > 0 ? "#4ade80" : "var(--app-text-muted)" }}>
                        {data.token.toFixed(6)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs" style={{ color: "var(--app-text-dim)" }}>USDT</span>
                      <span className="text-sm font-black font-mono" style={{ color: "var(--app-text-primary)" }}>
                        ${data.usdt.toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Cumulative running total ── */}
          <div className="flex items-center justify-between px-1">
            <span className="text-xs" style={{ color: "var(--app-text-dim)" }}>Running total after this step</span>
            <span className="text-sm font-black font-mono" style={{ color: cumColor }}>
              {cumulative >= 0 ? "+" : ""}{cumulative.toFixed(4)} USDT
            </span>
          </div>

          {t.note && (
            <p className="text-xs italic" style={{ color: "var(--app-text-dim)" }}>{t.note}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function TradesPane({ botState }) {
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [timeFilter, setTimeFilter]   = useState("lifetime");
  const [customFrom, setCustomFrom]   = useState("");   // YYYY-MM-DD
  const [customTo,   setCustomTo]     = useState("");
  const [copiedId,   setCopiedId]     = useState(null);  // order id being shown as "copied"

  const copyOrderId = useCallback((id) => {
    navigator.clipboard.writeText(id).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(prev => prev === id ? null : prev), 1800);
  }, []);

  const allTrades = botState?.trades ?? [];
  const cfg       = botState?.config ?? null;
  const token     = cfg?.token ?? "TOKEN";

  // Time-filtered trades for summary card stats
  const nowMs = Date.now();
  const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const todayStr   = new Date().toISOString().slice(0, 10);
  const customFromMs = customFrom ? new Date(customFrom).getTime()               : null;
  const customToMs   = customTo   ? new Date(customTo + "T23:59:59").getTime()   : null;
  const filteredTrades = (() => {
    if (timeFilter === "today")    return allTrades.filter(t => t.timestamp >= todayStart);
    if (timeFilter === "7d")       return allTrades.filter(t => t.timestamp >= nowMs - 7*24*3600*1000);
    if (timeFilter === "30d")      return allTrades.filter(t => t.timestamp >= nowMs - 30*24*3600*1000);
    if (timeFilter === "custom")   return allTrades.filter(t => {
      if (customFromMs != null && t.timestamp < customFromMs) return false;
      if (customToMs   != null && t.timestamp > customToMs)   return false;
      return true;
    });
    return allTrades; // "lifetime" / "all" — every trade ever, never deleted
  })();

  const harvestTrades  = filteredTrades.filter(t => t.tradeType === "harvest");
  const totalTds   = filteredTrades.reduce((s, t) => s + t.tdsUsdt,  0);
  const totalFees  = filteredTrades.reduce((s, t) => s + t.feesUsdt, 0);
  const totalNet   = filteredTrades.reduce((s, t) => s + t.netProfit, 0);
  const rounds     = harvestTrades.length;

  // Transaction volume: sum of every buy-leg + sell-leg across filtered trades
  const totalBuyVol  = filteredTrades.reduce((s, t) => s + (t.buyPrice  && t.qty ? t.qty * t.buyPrice  : 0), 0);
  const totalSellVol = filteredTrades.reduce((s, t) => s + (t.sellPrice && t.qty ? t.qty * t.sellPrice : 0), 0);
  const totalVolume  = totalBuyVol + totalSellVol;

  // Initial trade capital (from INIT's inv.b.usdt or botState)
  const tradeCapital = cfg?.tradeAmountUsdt
    ?? botState?.config?.tradeAmountUsdt
    ?? 100;

  // Net % on initial capital
  const netPct = tradeCapital > 0 ? (totalNet / tradeCapital) * 100 : 0;

  // Cumulative running P&L
  let running = 0;
  const cumByIdx = allTrades.map(t => { running += t.netProfit; return running; });

  const sel     = selectedIdx !== null ? allTrades[selectedIdx] : null;
  const selMeta = sel ? (TYPE_META[sel.tradeType] ?? TYPE_META.harvest) : null;
  const selCum  = selectedIdx !== null ? (cumByIdx[selectedIdx] ?? 0) : 0;
  const netColor = sel ? (sel.netProfit >= 0 ? "#4ade80" : "#f87171") : "#888";
  const cumColor = selCum >= 0 ? "#4ade80" : "#f87171";
  const cumPct = tradeCapital > 0 ? (selCum / tradeCapital) * 100 : 0;
  const exALabel = cfg?.exchangeA ?? "A";
  const exBLabel = cfg?.exchangeB ?? "B";

  // Node label for progress bar
  function nodeLabel(t) {
    if (t.tradeType === "init")    return "INIT";
    if (t.tradeType === "exit")    return "EXIT";
    return `R${t.roundNum}`;
  }

  return (
    <div className="flex flex-col gap-3 p-4">

      {/* ── Big Summary Card ── */}
      <div className="rounded-2xl p-4 flex flex-col gap-4"
        style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}>

        {/* Row 1: PNL hero + time filter */}
        <div className="flex items-start justify-between gap-3">
          {/* PNL hero */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Net P&amp;L</span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black font-mono" style={{ color: totalNet >= 0 ? "#4ade80" : "#f87171" }}>
                {totalNet >= 0 ? "+" : ""}{totalNet.toFixed(4)}
                <span className="text-sm font-bold ml-1" style={{ color: "var(--app-text-dim)" }}>USDT</span>
              </span>
              <span className="text-sm font-black font-mono px-2 py-0.5 rounded-lg"
                style={{
                  background: (totalNet >= 0 ? "#4ade80" : "#f87171") + "18",
                  border: `1px solid ${(totalNet >= 0 ? "#4ade80" : "#f87171")}44`,
                  color: totalNet >= 0 ? "#4ade80" : "#f87171"
                }}>
                {netPct >= 0 ? "+" : ""}{netPct.toFixed(2)}%
              </span>
            </div>
          </div>

          {/* Time filter */}
          <div className="flex flex-col items-end gap-1.5">
            <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Time Filter</span>
            <select
              value={timeFilter}
              onChange={e => { setTimeFilter(e.target.value); setCustomFrom(""); setCustomTo(""); }}
              className="text-xs font-bold rounded-lg px-2 py-1 outline-none cursor-pointer"
              style={{
                background: "var(--app-bg)",
                border: "1px solid var(--app-border-1)",
                color: "var(--app-text-primary)",
              }}>
              <option value="lifetime">♾ Lifetime</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
              <option value="custom">📅 Custom Range</option>
            </select>

            {/* Custom date range inputs */}
            {timeFilter === "custom" && (
              <div className="flex items-center gap-1.5 mt-0.5">
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || todayStr}
                  onChange={e => setCustomFrom(e.target.value)}
                  className="text-[10px] font-mono rounded-lg px-2 py-1 outline-none cursor-pointer"
                  style={{
                    background: "var(--app-bg)",
                    border: "1px solid var(--app-border-1)",
                    color: customFrom ? "var(--app-text-primary)" : "var(--app-text-dim)",
                  }}
                />
                <span className="text-[9px] font-bold" style={{ color: "var(--app-text-dim)" }}>→</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom}
                  max={todayStr}
                  onChange={e => setCustomTo(e.target.value)}
                  className="text-[10px] font-mono rounded-lg px-2 py-1 outline-none cursor-pointer"
                  style={{
                    background: "var(--app-bg)",
                    border: "1px solid var(--app-border-1)",
                    color: customTo ? "var(--app-text-primary)" : "var(--app-text-dim)",
                  }}
                />
                {(customFrom || customTo) && (
                  <button
                    onClick={() => { setCustomFrom(""); setCustomTo(""); }}
                    className="text-[10px] px-1.5 py-1 rounded-lg font-bold"
                    style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.3)" }}>
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Row 2: stat pills */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {/* Total Trades */}
          <div className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
            style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)" }}>
            <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Total Trades</span>
            <span className="text-lg font-black font-mono" style={{ color: "var(--app-text-primary)" }}>{filteredTrades.length}</span>
            <span className="text-[8px] font-mono" style={{ color: "var(--app-text-dim)" }}>{rounds} harvest rounds</span>
          </div>

          {/* Total TDS */}
          <div className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
            style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)" }}>
            <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Total TDS</span>
            <span className="text-lg font-black font-mono" style={{ color: "#f87171" }}>−{totalTds.toFixed(4)}</span>
            <span className="text-[8px] font-mono" style={{ color: "var(--app-text-dim)" }}>USDT @ 1%</span>
          </div>

          {/* Total Fees */}
          <div className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
            style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)" }}>
            <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Total Fees</span>
            <span className="text-lg font-black font-mono" style={{ color: "#fb923c" }}>−{totalFees.toFixed(4)}</span>
            <span className="text-[8px] font-mono" style={{ color: "var(--app-text-dim)" }}>USDT (GST incl.)</span>
          </div>

          {/* Transaction Volume */}
          <div className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
            style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)" }}>
            <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>TX Volume</span>
            <span className="text-lg font-black font-mono" style={{ color: "#a78bfa" }}>{totalVolume.toFixed(2)}</span>
            <span className="text-[8px] font-mono" style={{ color: "var(--app-text-dim)" }}>
              B {totalBuyVol.toFixed(1)} · S {totalSellVol.toFixed(1)} USDT
            </span>
          </div>
        </div>
      </div>

      {/* ── Progress bar stepper ── */}
      {allTrades.length > 0 && (
        <div className="rounded-2xl p-4 flex flex-col gap-3"
          style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}>

          {/* Node row */}
          <div className="flex items-end">
            {allTrades.map((t, i) => {
              const meta    = TYPE_META[t.tradeType] ?? TYPE_META.harvest;
              const active  = i === selectedIdx;
              const done    = i < selectedIdx;
              const nodeCol = active ? meta.color : done ? meta.color : "var(--app-border-1)";
              const netP    = t.netProfit;
              const pColor  = netP >= 0 ? "#4ade80" : "#f87171";
              const ts      = new Date(t.timestamp);
              const prevTs  = i > 0 ? new Date(allTrades[i - 1].timestamp) : null;
              const cycleMs = prevTs ? t.timestamp - allTrades[i - 1].timestamp : 0;
              const cycleStr = fmtDur(cycleMs);
              return (
                <div key={t.id} className="flex items-end" style={{ flex: i < allTrades.length - 1 ? "1" : "0 0 auto" }}>
                  {/* Node */}
                  <button
                    onClick={() => setSelectedIdx(prev => prev === i ? null : i)}
                    className="flex flex-col items-center gap-1 flex-shrink-0"
                    style={{ minWidth: 64 }}
                  >
                    {/* NET PROFIT above node */}
                    <div className="flex flex-col items-center gap-0">
                      <span className="text-[7px] font-bold uppercase tracking-wider" style={{ color: "var(--app-text-dim)" }}>Profit</span>
                      <span className="text-[10px] font-black font-mono" style={{ color: pColor }}>
                        {netP >= 0 ? "+" : ""}{netP.toFixed(3)}
                      </span>
                    </div>

                    {/* Circle */}
                    <div className="flex items-center justify-center rounded-full transition-all"
                      style={{
                        width: active ? 42 : 34,
                        height: active ? 42 : 34,
                        background: active ? meta.bg : done ? meta.color + "22" : "var(--app-bg)",
                        border: `2px solid ${nodeCol}`,
                        color: active ? meta.color : done ? meta.color : "var(--app-text-dim)",
                        fontSize: active ? 11 : 9,
                        fontWeight: 900,
                        boxShadow: active ? `0 0 14px ${meta.color}55` : "none",
                        flexShrink: 0,
                      }}>
                      {nodeLabel(t)}
                    </div>

                    {/* Date + Time + Cycle below node */}
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[8px] font-mono font-bold" style={{ color: active ? "var(--app-text-muted)" : "var(--app-text-dim)" }}>
                        {ts.toLocaleDateString([], { day: "numeric", month: "short" })}
                      </span>
                      <span className="text-[8px] font-mono" style={{ color: active ? "var(--app-text-dim)" : "var(--app-text-dim)", opacity: 0.8 }}>
                        {ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className="text-[7px] font-mono px-1 rounded"
                        style={{ background: "var(--app-bg)", color: "var(--app-text-dim)", border: "1px solid var(--app-border-0)" }}>
                        +{cycleStr}
                      </span>
                    </div>
                  </button>

                  {/* Connector line — vertically centered on circles */}
                  {i < allTrades.length - 1 && (
                    <div className="flex-1 h-0.5 mx-1 rounded-full mb-9" style={{
                      background: i < selectedIdx
                        ? (TYPE_META[allTrades[i + 1]?.tradeType]?.color ?? "#4ade80") + "55"
                        : "var(--app-border-0)",
                    }} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Cumulative progress bar */}
          <div className="flex flex-col gap-1">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--app-bg)" }}>
              <div className="h-full rounded-full transition-all"
                style={{
                  width: `${allTrades.length > 1 ? ((selectedIdx) / (allTrades.length - 1)) * 100 : 100}%`,
                  background: `linear-gradient(90deg, #60a5fa, #4ade80)`,
                }} />
            </div>
            <div className="flex justify-between">
              <span className="text-[8px]" style={{ color: "var(--app-text-dim)" }}>Start</span>
              <span className="flex items-center gap-1.5 font-mono font-bold" style={{ color: cumColor }}>
                <span className="text-[8px]">Cumulative: {selCum >= 0 ? "+" : ""}{selCum.toFixed(4)} USDT</span>
                <span className="text-[8px] px-1 py-0.5 rounded"
                  style={{ background: cumColor + "18", border: `1px solid ${cumColor}44` }}>
                  {cumPct >= 0 ? "+" : ""}{cumPct.toFixed(2)}%
                </span>
              </span>
              <span className="text-[8px]" style={{ color: "var(--app-text-dim)" }}>End</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Selected step detail ── */}
      {sel && selMeta && (
        <div className="rounded-2xl overflow-hidden"
          style={{ border: `1px solid ${selMeta.color}44` }}>

          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3"
            style={{ background: selMeta.bg, borderBottom: `1px solid ${selMeta.color}25` }}>
            {/* Big serial number */}
            <div className="flex items-center justify-center rounded-xl flex-shrink-0"
              style={{ width: 44, height: 44, background: selMeta.color + "22", border: `2px solid ${selMeta.color}66` }}>
              <span className="font-black font-mono" style={{ color: selMeta.color, fontSize: 18, lineHeight: 1 }}>
                #{selectedIdx + 1}
              </span>
            </div>
            {/* Title + step */}
            <div className="flex flex-col gap-0.5 flex-1">
              <span className="text-sm font-black uppercase tracking-wide" style={{ color: selMeta.color }}>
                {sel.tradeType === "init" ? "Init Buy" : sel.tradeType === "exit" ? "Exit Sell" : `Round ${sel.roundNum} — Harvest Flip`}
              </span>
              <span className="text-[9px] font-bold" style={{ color: "var(--app-text-dim)" }}>
                Trade {selectedIdx + 1} of {allTrades.length}
              </span>
            </div>
            <span className="text-[10px] font-mono flex-shrink-0" style={{ color: "var(--app-text-dim)" }}>
              {new Date(sel.timestamp).toLocaleTimeString()}
            </span>
          </div>

          <div className="p-4 flex flex-col gap-3" style={{ background: "var(--app-surface-1)" }}>

            {/* Route + Prices row */}
            <div className="flex items-stretch gap-3">
              {/* Route */}
              <div className="flex flex-col justify-center gap-2 px-3 py-2 rounded-xl flex-shrink-0"
                style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)", minWidth: 140 }}>
                {sel.tradeType === "harvest" ? (
                  <>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "#f87171" }}>Sell on</span>
                      <ExPill name={sel.sellExchange} />
                    </div>
                    <div className="w-full h-px" style={{ background: "var(--app-border-0)" }} />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "#4ade80" }}>Buy on</span>
                      <ExPill name={sel.buyExchange} />
                    </div>
                  </>
                ) : sel.tradeType === "init" ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Buy on</span>
                    <ExPill name={sel.buyExchange} />
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Sell on</span>
                    <ExPill name={sel.sellExchange} />
                  </div>
                )}
              </div>

              {/* Prices + Qty */}
              <div className="flex-1 grid gap-2" style={{ gridTemplateColumns: sel.tradeType === "harvest" ? "1fr 1fr 1fr" : "1fr 1fr" }}>
                {sel.tradeType === "harvest" && (
                  <div className="rounded-xl px-3 py-2 flex flex-col gap-0.5"
                    style={{ background: "rgba(248,113,113,0.07)", border: "1px solid rgba(248,113,113,0.2)" }}>
                    <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "#f87171" }}>Sell Price</span>
                    <span className="text-sm font-black font-mono" style={{ color: "#f87171" }}>{fmtPx(sel.sellPrice)}</span>
                  </div>
                )}
                {sel.tradeType === "harvest" && (
                  <div className="rounded-xl px-3 py-2 flex flex-col gap-0.5"
                    style={{ background: "rgba(74,222,128,0.07)", border: "1px solid rgba(74,222,128,0.2)" }}>
                    <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "#4ade80" }}>Buy Price</span>
                    <span className="text-sm font-black font-mono" style={{ color: "#4ade80" }}>{fmtPx(sel.buyPrice)}</span>
                  </div>
                )}
                {(sel.tradeType === "init" || sel.tradeType === "exit") && (
                  <div className="rounded-xl px-3 py-2 flex flex-col gap-0.5"
                    style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)" }}>
                    <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>
                      {sel.tradeType === "init" ? "Buy Price" : "Sell Price"}
                    </span>
                    <span className="text-sm font-black font-mono" style={{ color: "var(--app-text-primary)" }}>
                      {fmtPx(sel.tradeType === "init" ? sel.buyPrice : sel.sellPrice)}
                    </span>
                  </div>
                )}
                <div className="rounded-xl px-3 py-2 flex flex-col gap-0.5"
                  style={{ background: "var(--app-bg)", border: "1px solid var(--app-border-0)" }}>
                  <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Quantity</span>
                  <span className="text-sm font-black font-mono" style={{ color: "var(--app-text-primary)" }}>
                    {sel.qty.toFixed(4)} <span className="text-xs font-normal" style={{ color: "var(--app-text-dim)" }}>{token}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* P&L row */}
            <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--app-border-0)" }}>
              <div className="grid grid-cols-4 divide-x" style={{ borderColor: "var(--app-border-0)" }}>
                {[
                  { label: "Gross",      val: `${sel.grossProfit>0?"+":""}${sel.grossProfit.toFixed(4)}`, color: "var(--app-text-primary)" },
                  { label: `TDS (${cfg?.tdsPct ?? 1}%)`,   val: `−${sel.tdsUsdt.toFixed(4)}`,   color: "#f87171" },
                  { label: "Fees",       val: `−${sel.feesUsdt.toFixed(4)}`,  color: "#fb923c" },
                  { label: "Net Profit", val: `${sel.netProfit>=0?"+":""}${sel.netProfit.toFixed(4)}`, color: netColor, bold: true },
                ].map(({ label, val, color, bold }) => (
                  <div key={label} className="flex flex-col gap-0.5 px-3 py-2"
                    style={{ background: bold ? (sel.netProfit >= 0 ? "rgba(74,222,128,0.07)" : "rgba(248,113,113,0.07)") : "var(--app-surface-1)" }}>
                    <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>{label}</span>
                    <span className={`font-mono font-black ${bold ? "text-sm" : "text-xs"}`} style={{ color }}>
                      {val} <span className="text-[8px] font-normal" style={{ color: "var(--app-text-dim)" }}>USDT</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Order Details */}
            {(sel.sellOrderId || sel.buyOrderId) && (
              <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--app-border-0)" }}>
                <div className="px-3 py-1.5" style={{ background: "var(--app-bg)", borderBottom: "1px solid var(--app-border-0)" }}>
                  <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>Order Details</span>
                </div>
                <div className="flex flex-col divide-y" style={{ borderColor: "var(--app-border-0)" }}>
                  {sel.sellOrderId && (
                    <div className="flex items-center justify-between px-3 py-2" style={{ background: "var(--app-surface-1)" }}>
                      <div className="flex items-center gap-2">
                        <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded"
                          style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.25)" }}>
                          SELL
                        </span>
                        <ExPill name={sel.sellExchange} />
                        <span className="text-[10px] font-mono" style={{ color: "var(--app-text-muted)" }}>{sel.sellOrderId}</span>
                        <button
                          onClick={() => copyOrderId(sel.sellOrderId)}
                          title="Copy order ID"
                          className="flex items-center justify-center rounded transition-all"
                          style={{
                            width: 18, height: 18,
                            color: copiedId === sel.sellOrderId ? "#4ade80" : "var(--app-text-dim)",
                            background: copiedId === sel.sellOrderId ? "rgba(74,222,128,0.12)" : "transparent",
                            border: "none", cursor: "pointer", flexShrink: 0,
                          }}>
                          {copiedId === sel.sellOrderId
                            ? <Check style={{ width: 11, height: 11 }} />
                            : <Copy style={{ width: 11, height: 11 }} />}
                        </button>
                      </div>
                      {sel.sellStatus && (
                        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full"
                          style={{
                            background: /filled|success/i.test(sel.sellStatus) ? "rgba(74,222,128,0.12)" : "rgba(148,163,184,0.12)",
                            color: /filled|success/i.test(sel.sellStatus) ? "#4ade80" : "#94a3b8",
                            border: `1px solid ${/filled|success/i.test(sel.sellStatus) ? "rgba(74,222,128,0.3)" : "rgba(148,163,184,0.2)"}`,
                          }}>
                          {sel.sellStatus.toUpperCase()}
                        </span>
                      )}
                    </div>
                  )}
                  {sel.buyOrderId && (
                    <div className="flex items-center justify-between px-3 py-2" style={{ background: "var(--app-surface-1)" }}>
                      <div className="flex items-center gap-2">
                        <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded"
                          style={{ background: "rgba(74,222,128,0.12)", color: "#4ade80", border: "1px solid rgba(74,222,128,0.25)" }}>
                          BUY
                        </span>
                        <ExPill name={sel.buyExchange} />
                        <span className="text-[10px] font-mono" style={{ color: "var(--app-text-muted)" }}>{sel.buyOrderId}</span>
                        <button
                          onClick={() => copyOrderId(sel.buyOrderId)}
                          title="Copy order ID"
                          className="flex items-center justify-center rounded transition-all"
                          style={{
                            width: 18, height: 18,
                            color: copiedId === sel.buyOrderId ? "#4ade80" : "var(--app-text-dim)",
                            background: copiedId === sel.buyOrderId ? "rgba(74,222,128,0.12)" : "transparent",
                            border: "none", cursor: "pointer", flexShrink: 0,
                          }}>
                          {copiedId === sel.buyOrderId
                            ? <Check style={{ width: 11, height: 11 }} />
                            : <Copy style={{ width: 11, height: 11 }} />}
                        </button>
                      </div>
                      {sel.buyStatus && (
                        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full"
                          style={{
                            background: /filled|success/i.test(sel.buyStatus) ? "rgba(74,222,128,0.12)" : "rgba(148,163,184,0.12)",
                            color: /filled|success/i.test(sel.buyStatus) ? "#4ade80" : "#94a3b8",
                            border: `1px solid ${/filled|success/i.test(sel.buyStatus) ? "rgba(74,222,128,0.3)" : "rgba(148,163,184,0.2)"}`,
                          }}>
                          {sel.buyStatus.toUpperCase()}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Inventory after */}
            {sel.inventoryAfter && (
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: exALabel, data: sel.inventoryAfter.a },
                  { label: exBLabel, data: sel.inventoryAfter.b },
                ].map(({ label, data }) => {
                  const col = EXCHANGE_COLORS[label] ?? "#888";
                  return (
                    <div key={label} className="rounded-xl px-3 py-2.5 flex flex-col gap-2"
                      style={{ background: "var(--app-bg)", border: `1px solid ${col}33` }}>
                      <span className="text-[9px] font-bold uppercase" style={{ color: col }}>{label} — after</span>
                      <div className="flex justify-between items-center">
                        <span className="text-[9px]" style={{ color: "var(--app-text-dim)" }}>{token}</span>
                        <span className="text-sm font-black font-mono" style={{ color: data.token > 0 ? "#4ade80" : "var(--app-text-muted)" }}>
                          {data.token.toFixed(6)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[9px]" style={{ color: "var(--app-text-dim)" }}>USDT</span>
                        <span className="text-sm font-black font-mono" style={{ color: "var(--app-text-primary)" }}>
                          ${data.usdt.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Cumulative + nav */}
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  className="px-3 py-1 rounded-lg text-xs font-bold"
                  style={{ background: "var(--app-bg)", color: selectedIdx === 0 ? "var(--app-text-dim)" : "var(--app-text-primary)", border: "1px solid var(--app-border-0)", opacity: selectedIdx === 0 ? 0.4 : 1 }}
                  disabled={selectedIdx === 0}
                  onClick={() => setSelectedIdx(i => Math.max(0, i - 1))}
                >← Prev</button>
                <button
                  className="px-3 py-1 rounded-lg text-xs font-bold"
                  style={{ background: "var(--app-bg)", color: selectedIdx === allTrades.length - 1 ? "var(--app-text-dim)" : "var(--app-text-primary)", border: "1px solid var(--app-border-0)", opacity: selectedIdx === allTrades.length - 1 ? 0.4 : 1 }}
                  disabled={selectedIdx === allTrades.length - 1}
                  onClick={() => setSelectedIdx(i => Math.min(allTrades.length - 1, i + 1))}
                >Next →</button>
              </div>
              <span className="text-xs font-black font-mono" style={{ color: cumColor }}>
                Running total: {selCum >= 0 ? "+" : ""}{selCum.toFixed(4)} USDT
              </span>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export function SpotHedgeTab({ activeSubTab = "bot" }) {
  const [botState, setBotState] = useState(null);
  const timerRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const s = await apiFetch(`${API}/state`);
      setBotState(s);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 1_000);
    return () => clearInterval(timerRef.current);
  }, [refresh]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {activeSubTab === "bot"    && <BotPane    botState={botState} onRefresh={refresh} />}
        {activeSubTab === "trades" && <TradesPane botState={botState} />}
        {activeSubTab === "alerts" && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8" style={{ color: "var(--app-text-muted)" }}>
            <BellRing style={{ width: 40, height: 40, color: "var(--app-success)", opacity: 0.45 }} />
            <div className="text-center">
              <p className="text-sm font-bold uppercase tracking-widest mb-1" style={{ color: "var(--app-text-bright)" }}>Spot-Hedge · Alerts</p>
              <p className="text-xs" style={{ color: "var(--app-text-dim)" }}>Telegram alerts for trade execution, phase changes, and P&L — coming soon</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
