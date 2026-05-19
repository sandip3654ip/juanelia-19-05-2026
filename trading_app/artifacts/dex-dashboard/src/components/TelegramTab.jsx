import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell, BellRing, Send, CheckCircle2, XCircle,
  AlertTriangle, Clock, RefreshCw, MessageCircle,
  ChevronDown, ChevronUp, Loader2, Settings2,
  Zap, ShieldCheck, History, Bot,
} from "lucide-react";

// ── Design tokens ────────────────────────────────────────────────────────────

const TG_BLUE  = "#29b6f6";
const TG_BLUE2 = "rgba(41,182,246,0.12)";
const TG_BLUE3 = "rgba(41,182,246,0.25)";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtAge(ms) {
  if (ms < 60_000)   return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3600_000)}h ago`;
}
function fmtPct(v) {
  if (v == null || !isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`;
}

const PERIOD_OPTIONS = [
  { label: "4H",  ms: 4  * 3_600_000 },
  { label: "8H",  ms: 8  * 3_600_000 },
  { label: "12H", ms: 12 * 3_600_000 },
  { label: "24H", ms: 24 * 3_600_000 },
];

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }) {
  const W = 48; const H = 26; const D = 20; const PAD = 3;
  const [squish, setSquish] = useState(false);
  const handleClick = () => {
    if (disabled) return;
    setSquish(true); onChange(!checked);
    setTimeout(() => setSquish(false), 220);
  };
  const extraW    = squish ? 8 : 0;
  const thumbW    = D + extraW;
  const thumbLeft = checked ? W - thumbW - PAD : PAD;
  return (
    <button role="switch" aria-checked={checked} onClick={handleClick}
      title={disabled ? "Configure Telegram to enable" : checked ? "Alerts ON" : "Alerts OFF"}
      style={{
        width: W, height: H, borderRadius: H / 2,
        background: checked ? TG_BLUE : "var(--app-surface-2)",
        border: `1.5px solid ${checked ? TG_BLUE : "var(--app-border-1)"}`,
        boxShadow: checked ? `0 0 10px ${TG_BLUE}44` : "inset 0 2px 4px rgba(0,0,0,0.25)",
        position: "relative", cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.22s, border-color 0.22s, box-shadow 0.22s",
        flexShrink: 0, opacity: disabled ? 0.4 : 1,
        padding: 0, outline: "none", display: "block",
      }}>
      <span style={{
        position: "absolute", top: "50%", left: thumbLeft,
        width: thumbW, height: D, borderRadius: D / 2,
        background: "#fff", boxShadow: "0 1px 5px rgba(0,0,0,0.35)",
        transform: "translateY(-50%)",
        transition: "left 0.22s ease, width 0.14s ease",
        display: "block",
      }} />
    </button>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color, accent }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl p-4"
      style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)", minWidth: 0 }}>
      <div className="flex items-center gap-1.5">
        <Icon style={{ width: 12, height: 12, color: accent ?? "var(--app-text-muted)", flexShrink: 0 }} />
        <span className="text-[10px] font-bold uppercase tracking-widest truncate"
          style={{ color: "var(--app-text-dimmer)" }}>
          {label}
        </span>
      </div>
      <span className="text-2xl font-bold font-mono leading-none" style={{ color: color ?? "var(--app-text-primary)" }}>
        {value}
      </span>
      {sub && <span className="text-[10px]" style={{ color: "var(--app-text-dimmer)" }}>{sub}</span>}
    </div>
  );
}

// ── Numeric input with suffix ─────────────────────────────────────────────────

function NumInput({ value, onChange, onCommit, step = 0.1, min = 0, suffix, placeholder, disabled, accentBorder }) {
  return (
    <div className="flex items-center h-10 rounded-lg"
      style={{
        background: "var(--app-surface-0)",
        border: `1px solid ${disabled ? "var(--app-border-1)" : (accentBorder ?? "var(--app-border-2)")}`,
        opacity: disabled ? 0.5 : 1,
        overflow: "hidden",
      }}>
      <input
        type="number" step={step} min={min} placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => e.key === "Enter" && onCommit()}
        disabled={disabled}
        className="min-w-0 w-0 flex-1 h-full pl-3 pr-1 text-sm font-bold font-mono outline-none bg-transparent"
        style={{ color: disabled ? "var(--app-text-dimmer)" : "var(--app-text-bright)" }}
      />
      {suffix && (
        <span className="px-2.5 h-full flex items-center text-[11px] font-bold flex-shrink-0 whitespace-nowrap"
          style={{ background: "var(--app-surface-1)", borderLeft: "1px solid var(--app-border-1)", color: "var(--app-text-muted)" }}>
          {suffix}
        </span>
      )}
    </div>
  );
}

// ── Setup step ────────────────────────────────────────────────────────────────

function SetupStep({ n, text, done }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5"
        style={{
          background: done ? "var(--app-success-soft)" : TG_BLUE2,
          color:      done ? "var(--app-success)"      : TG_BLUE,
          border:     `1px solid ${done ? "var(--app-success-border)" : TG_BLUE3}`,
        }}>
        {done ? "✓" : n}
      </span>
      <span className="text-[12px] leading-relaxed pt-0.5"
        style={{ color: done ? "var(--app-text-muted)" : "var(--app-text-dim)" }}>
        {text}
      </span>
    </div>
  );
}

// ── History row ───────────────────────────────────────────────────────────────

function HistoryRow({ ev, now }) {
  const profit = ev.netProfitPct;
  const pos = profit >= 0;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-3"
      style={{ background: "var(--app-surface-0)", border: "1px solid var(--app-border-0)" }}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: TG_BLUE2, border: `1px solid ${TG_BLUE3}` }}>
          <MessageCircle style={{ width: 12, height: 12, color: TG_BLUE }} />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-bold font-mono" style={{ color: "var(--app-text-primary)" }}>
            {ev.symbol}
          </span>
          <span className="text-[10px]" style={{ color: "var(--app-text-dimmer)" }}>
            {ev.buyExchange}
            <span style={{ margin: "0 4px", opacity: 0.5 }}>→</span>
            {ev.sellExchange}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-sm font-bold font-mono px-2.5 py-1 rounded-lg"
          style={{
            background: pos ? "var(--app-success-soft)" : "var(--app-danger-soft)",
            color:      pos ? "var(--app-success)"      : "var(--app-danger)",
            border:     pos ? "1px solid var(--app-success-border)" : "1px solid var(--app-danger-border)",
          }}>
          {fmtPct(profit)}
        </span>
        <span className="text-[10px] font-mono tabular-nums"
          style={{ color: "var(--app-text-dimmer)", minWidth: 52, textAlign: "right" }}>
          {fmtAge(now - ev.sentAt)}
        </span>
      </div>
    </div>
  );
}

// ── Inline section header ─────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, title, badge, right, onClick, open }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-5 py-4 gap-3"
      style={{ background: "transparent", cursor: onClick ? "pointer" : "default" }}>
      <div className="flex items-center gap-2.5">
        {Icon && <Icon style={{ width: 14, height: 14, color: "var(--app-text-muted)", flexShrink: 0 }} />}
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
          {title}
        </span>
        {badge}
      </div>
      <div className="flex items-center gap-2">
        {right}
        {onClick && (open
          ? <ChevronUp   style={{ width: 14, height: 14, color: "var(--app-text-dimmer)" }} />
          : <ChevronDown style={{ width: 14, height: 14, color: "var(--app-text-dimmer)" }} />)}
      </div>
    </button>
  );
}

// ── Telegram icon (SVG) ───────────────────────────────────────────────────────

function TelegramIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="12" fill={TG_BLUE} opacity="0.15" />
      <path
        d="M5.5 11.5l12-4.5-2 10-3.5-3-2 2-1-4 5-4-6 3.5-.5-2z"
        stroke={TG_BLUE} strokeWidth="1.4" strokeLinejoin="round" fill="none"
      />
    </svg>
  );
}

// ── Main TelegramTab ──────────────────────────────────────────────────────────

export function TelegramTab() {
  const [now, setNow]                         = useState(() => Date.now());
  const [threshInput,   setThreshInput]       = useState("");
  const [minHitsInput,  setMinHitsInput]      = useState("0");
  const [maxMovInput,   setMaxMovInput]       = useState("");
  const [movPeriodMs,   setMovPeriodMs]       = useState(4 * 3_600_000);
  const [cooldownInput, setCooldownInput]     = useState("");
  const [testStatus,    setTestStatus]        = useState(null);
  const [testError,     setTestError]         = useState(null);
  const [detectStatus,  setDetectStatus]      = useState(null);
  const [detectError,   setDetectError]       = useState(null);
  const [setupOpen,     setSetupOpen]         = useState(false);
  const [historyOpen,   setHistoryOpen]       = useState(true);
  const initRef = useRef(false);
  const qc = useQueryClient();

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey:        ["alerts-config"],
    queryFn:         async () => {
      const r = await fetch("/api/alerts/config");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 15_000,
    staleTime:       10_000,
  });

  const { data: history = [] } = useQuery({
    queryKey:        ["alerts-history"],
    queryFn:         async () => {
      const r = await fetch("/api/alerts/history");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled:         historyOpen,
    refetchInterval: 15_000,
    staleTime:       10_000,
  });

  const configMut = useMutation({
    mutationFn: async (patch) => {
      const r = await fetch("/api/alerts/config", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body:   JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: (data) => qc.setQueryData(["alerts-config"], data),
  });

  useEffect(() => {
    if (!config || initRef.current) return;
    initRef.current = true;
    setThreshInput(String(config.minNetProfitPct ?? 0.5));
    setMinHitsInput(String(config.minTimesHit ?? 0));
    setMaxMovInput(config.maxPriceMovementPct != null ? String(config.maxPriceMovementPct) : "");
    setMovPeriodMs(config.priceMovementPeriodMs ?? 4 * 3_600_000);
    setCooldownInput(String(config.cooldownMinutes ?? 0.5));
  }, [config]);

  // Auto-open setup guide when not configured
  useEffect(() => {
    if (config && !config.telegramConfigured) setSetupOpen(true);
  }, [config?.telegramConfigured]);

  const commitThresh   = () => { const v = parseFloat(threshInput);   if (isFinite(v)) configMut.mutate({ minNetProfitPct: v });    else setThreshInput(String(config?.minNetProfitPct ?? 0.5)); };
  const commitMinHits  = () => { const v = parseInt(minHitsInput, 10); if (Number.isFinite(v) && v >= 0) configMut.mutate({ minTimesHit: v });    else setMinHitsInput(String(config?.minTimesHit ?? 0)); };
  const commitMaxMov   = () => { const raw = maxMovInput.trim(); if (raw === "") { configMut.mutate({ maxPriceMovementPct: null }); return; } const v = parseFloat(raw); if (isFinite(v) && v > 0) configMut.mutate({ maxPriceMovementPct: v }); else setMaxMovInput(config?.maxPriceMovementPct != null ? String(config.maxPriceMovementPct) : ""); };
  const commitCooldown = () => { const v = parseFloat(cooldownInput); if (isFinite(v) && v >= 0.1) configMut.mutate({ cooldownMinutes: v }); else setCooldownInput(String(config?.cooldownMinutes ?? 0.5)); };

  const handleTest = async () => {
    setTestStatus("sending"); setTestError(null);
    try {
      const res  = await fetch("/api/alerts/test", { method: "POST" });
      const data = await res.json();
      if (data.ok) { setTestStatus("ok"); setTimeout(() => setTestStatus(null), 4000); }
      else          { setTestStatus("error"); setTestError(data.error ?? "Unknown error"); }
    } catch (e) { setTestStatus("error"); setTestError(String(e)); }
  };

  const handleDetect = async () => {
    setDetectStatus("detecting"); setDetectError(null);
    try {
      const res  = await fetch("/api/alerts/detect-chat-id", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setDetectStatus("ok");
        qc.invalidateQueries({ queryKey: ["alerts-config"] });
        setTimeout(() => setDetectStatus(null), 5000);
      } else { setDetectStatus("error"); setDetectError(data.error ?? "Detection failed"); }
    } catch (e) { setDetectStatus("error"); setDetectError(String(e)); }
  };

  const tokenOk    = config?.tokenConfigured    ?? false;
  const chatOk     = config?.telegramConfigured  ?? false;
  const enabled    = config?.enabled             ?? false;
  const isActive   = chatOk && enabled;
  const isMutating = configMut.isPending;

  // Today's IST alert count
  const todayCount = history.filter((h) => {
    const IST_OFFSET = 5.5 * 3_600_000;
    const todayStart = Math.floor((now + IST_OFFSET) / 86_400_000) * 86_400_000 - IST_OFFSET;
    return h.sentAt >= todayStart;
  }).length;

  return (
    <div className="flex flex-col gap-4 w-full">

      {/* ═══════════════════════════════════════════════════════════════════
          HERO STATUS BANNER
      ═══════════════════════════════════════════════════════════════════ */}
      <div
        className="rounded-2xl p-5 flex items-center justify-between gap-4"
        style={{
          background: isActive
            ? `linear-gradient(135deg, ${TG_BLUE2} 0%, var(--app-surface-1) 100%)`
            : chatOk
            ? "var(--app-surface-1)"
            : `linear-gradient(135deg, rgba(245,158,11,0.08) 0%, var(--app-surface-1) 100%)`,
          border: `1px solid ${isActive ? TG_BLUE3 : chatOk ? "var(--app-border-0)" : "var(--app-warning-border)"}`,
          transition: "all 0.3s",
        }}
      >
        <div className="flex items-center gap-4 min-w-0">
          {/* Telegram icon */}
          <div
            className="flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center"
            style={{
              background: isActive ? TG_BLUE2 : "var(--app-surface-2)",
              border: `1px solid ${isActive ? TG_BLUE3 : "var(--app-border-1)"}`,
            }}
          >
            {isActive
              ? <BellRing style={{ width: 22, height: 22, color: TG_BLUE }} />
              : <Bell     style={{ width: 22, height: 22, color: chatOk ? "var(--app-text-muted)" : "var(--app-warning)" }} />}
          </div>

          {/* Text */}
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-bold" style={{ color: isActive ? TG_BLUE : "var(--app-text-primary)" }}>
                Telegram Alerts
              </span>
              {isActive && (
                <span className="flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded-full"
                  style={{ background: TG_BLUE2, color: TG_BLUE, border: `1px solid ${TG_BLUE3}` }}>
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: TG_BLUE }} />
                  LIVE
                </span>
              )}
              {!chatOk && !configLoading && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                  style={{ background: "var(--app-warning-soft)", color: "var(--app-warning)", border: "1px solid var(--app-warning-border)" }}>
                  SETUP REQUIRED
                </span>
              )}
            </div>
            <span className="text-[11px] truncate" style={{ color: "var(--app-text-dim)" }}>
              {configLoading
                ? "Loading configuration…"
                : isActive
                ? `Monitoring live · ${config?.cooldownMinutes ?? 0.5}min cooldown per pair`
                : chatOk
                ? "Configured and ready — toggle to enable"
                : !tokenOk
                ? "Add TELEGRAM_BOT_TOKEN to Replit Secrets"
                : "Token verified — send a message to your bot, then auto-detect"}
            </span>
            {chatOk && config?.detectedChatId && (
              <span className="text-[10px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
                Chat ID: <span style={{ color: "var(--app-text-muted)" }}>{config.detectedChatId}</span>
                <button
                  onClick={handleDetect}
                  className="ml-2 text-[9px] font-bold uppercase tracking-wider"
                  style={{ color: "var(--app-text-dimmer)", cursor: "pointer", background: "transparent" }}
                  title="Re-detect Chat ID">
                  <RefreshCw style={{ width: 9, height: 9, display: "inline", verticalAlign: "middle" }} /> re-detect
                </button>
              </span>
            )}
          </div>
        </div>

        {/* Toggle */}
        <Toggle checked={enabled} onChange={(v) => configMut.mutate({ enabled: v })} disabled={!chatOk || isMutating} />
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          STATS ROW (only when configured)
      ═══════════════════════════════════════════════════════════════════ */}
      {chatOk && (
        <div className="grid grid-cols-3 sm:grid-cols-3 gap-3">
          <StatCard icon={MessageCircle} label="Sent Today" value={todayCount}
            color={todayCount > 0 ? TG_BLUE : "var(--app-text-primary)"} accent={TG_BLUE} />
          <StatCard icon={Clock} label="Cooldown" value={`${config?.cooldownMinutes ?? 0.5}m`}
            color="var(--app-text-primary)" accent="var(--app-text-muted)" />
          <StatCard icon={Zap} label="Min Profit" value={`${config?.minNetProfitPct ?? 0.5}%`}
            color="var(--app-success)" accent="var(--app-success)" />
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          TWO-COLUMN MAIN BODY
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

      {/* ── LEFT: Alert Filters ────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}>

        <div className="px-5 py-4 flex items-center justify-between gap-3"
          style={{ borderBottom: "1px solid var(--app-border-0)" }}>
          <div className="flex items-center gap-2">
            <Settings2 style={{ width: 14, height: 14, color: "var(--app-text-muted)" }} />
            <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
              Alert Filters
            </span>
          </div>
          {isMutating && (
            <span className="text-[10px]" style={{ color: "var(--app-text-dimmer)" }}>
              <Loader2 style={{ width: 11, height: 11, display: "inline", animation: "spin 1s linear infinite", marginRight: 4 }} />
              Saving…
            </span>
          )}
        </div>

        <div className="p-5 flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            {/* Min Net Profit */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                Min Net Profit
              </span>
              <NumInput value={threshInput} onChange={setThreshInput} onCommit={commitThresh}
                step={0.1} min={0} suffix="%" disabled={!chatOk}
                accentBorder={chatOk ? "var(--app-success-border)" : undefined} />
            </div>

            {/* Cooldown */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                Cooldown per pair
              </span>
              <NumInput value={cooldownInput} onChange={setCooldownInput} onCommit={commitCooldown}
                step={0.5} min={0.1} suffix="min" disabled={!chatOk} />
              <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>0.5 = 30 sec</span>
            </div>

            {/* Min Times Hit */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                  Min Times Hit
                </span>
                <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>4H window</span>
              </div>
              <NumInput value={minHitsInput} onChange={setMinHitsInput} onCommit={commitMinHits}
                step={1} min={0} suffix="×" disabled={!chatOk}
                accentBorder={chatOk ? "var(--app-success-border)" : undefined} />
              <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>0 = always alert</span>
            </div>

            {/* Max Price Movement */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                Max Price Movement
              </span>
              <div className="flex gap-2">
                <div className="flex-1">
                  <NumInput value={maxMovInput} onChange={setMaxMovInput} onCommit={commitMaxMov}
                    step={0.5} min={0} suffix="%" placeholder="no limit" disabled={!chatOk}
                    accentBorder={chatOk ? "var(--app-warning-border)" : undefined} />
                </div>
                <select
                  value={movPeriodMs}
                  onChange={(e) => { setMovPeriodMs(Number(e.target.value)); configMut.mutate({ priceMovementPeriodMs: Number(e.target.value) }); }}
                  disabled={!chatOk}
                  className="h-10 px-2 rounded-lg text-xs font-bold outline-none"
                  style={{
                    background: "var(--app-surface-0)", border: "1px solid var(--app-border-1)",
                    color: "var(--app-text-primary)", cursor: chatOk ? "pointer" : "not-allowed", minWidth: 62,
                    opacity: chatOk ? 1 : 0.5,
                  }}>
                  {PERIOD_OPTIONS.map((o) => (
                    <option key={o.ms} value={o.ms} style={{ background: "var(--app-surface-0)" }}>{o.label}</option>
                  ))}
                </select>
              </div>
              <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>empty = no limit</span>
            </div>
          </div>

          {/* Active summary pill */}
          {config && chatOk && (
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5"
              style={{ background: "var(--app-surface-0)", border: "1px solid var(--app-border-0)" }}>
              <Zap style={{ width: 11, height: 11, color: "var(--app-success)", flexShrink: 0 }} />
              <span className="text-[10px] leading-relaxed" style={{ color: "var(--app-text-dim)" }}>
                Alert when profit ≥{" "}
                <b style={{ color: "var(--app-success)", fontFamily: "monospace" }}>{config.minNetProfitPct}%</b>
                {(config.minTimesHit ?? 0) > 0 && (
                  <> · hits ≥ <b style={{ color: "var(--app-success)", fontFamily: "monospace" }}>{config.minTimesHit}×</b></>
                )}
                {config.maxPriceMovementPct != null && (
                  <> · movement ≤ <b style={{ color: "var(--app-warning)", fontFamily: "monospace" }}>{config.maxPriceMovementPct}%</b>
                    <span style={{ color: "var(--app-text-dimmer)" }}> ({PERIOD_OPTIONS.find((o) => o.ms === (config.priceMovementPeriodMs ?? movPeriodMs))?.label ?? "?"})</span>
                  </>
                )}
              </span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3 flex-wrap pt-1" style={{ borderTop: "1px solid var(--app-border-0)" }}>
            {/* Test Alert */}
            <button
              onClick={handleTest}
              disabled={!chatOk || testStatus === "sending"}
              className="flex items-center gap-2 h-10 px-5 rounded-xl text-[11px] font-bold uppercase tracking-wider"
              style={{
                background: testStatus === "ok"    ? "var(--app-success-soft)"
                          : testStatus === "error" ? "var(--app-danger-soft)"
                          :                          TG_BLUE2,
                border:  testStatus === "ok"    ? "1px solid var(--app-success-border)"
                       : testStatus === "error" ? "1px solid var(--app-danger-border)"
                       :                          `1px solid ${TG_BLUE3}`,
                color:   testStatus === "ok"    ? "var(--app-success)"
                       : testStatus === "error" ? "var(--app-danger)"
                       :                          TG_BLUE,
                cursor:  (!chatOk || testStatus === "sending") ? "not-allowed" : "pointer",
                opacity: !chatOk ? 0.45 : 1,
                transition: "all 0.18s",
              }}>
              {testStatus === "sending"
                ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Sending…</>
                : testStatus === "ok"
                ? <><CheckCircle2 style={{ width: 13, height: 13 }} /> Sent!</>
                : testStatus === "error"
                ? <><XCircle style={{ width: 13, height: 13 }} /> Failed</>
                : <><Send style={{ width: 13, height: 13 }} /> Test Alert</>
              }
            </button>

            {/* Auto-detect (shown when token ok but chat not detected) */}
            {tokenOk && !chatOk && (
              <button
                onClick={handleDetect}
                disabled={detectStatus === "detecting"}
                className="flex items-center gap-2 h-10 px-5 rounded-xl text-[11px] font-bold uppercase tracking-wider"
                style={{
                  background: detectStatus === "ok" ? "var(--app-success-soft)" : "var(--app-surface-2)",
                  border:     detectStatus === "ok" ? "1px solid var(--app-success-border)" : "1px solid var(--app-border-1)",
                  color:      detectStatus === "ok" ? "var(--app-success)" : "var(--app-text-muted)",
                  cursor:     detectStatus === "detecting" ? "not-allowed" : "pointer",
                }}>
                {detectStatus === "detecting"
                  ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Detecting…</>
                  : detectStatus === "ok"
                  ? <><CheckCircle2 style={{ width: 13, height: 13 }} /> Detected!</>
                  : <><RefreshCw style={{ width: 13, height: 13 }} /> Auto-detect Chat ID</>
                }
              </button>
            )}

            {testStatus === "error" && testError && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-[10px] flex-1"
                style={{ background: "var(--app-danger-soft)", border: "1px solid var(--app-danger-border)", color: "var(--app-danger)" }}>
                <XCircle style={{ width: 11, height: 11, flexShrink: 0 }} />
                {testError.slice(0, 100)}
              </div>
            )}
            {detectStatus === "error" && detectError && (
              <span className="text-[10px]" style={{ color: "var(--app-danger)" }}>{detectError.slice(0, 100)}</span>
            )}
          </div>
        </div>
      </div>
      </div>{/* end LEFT column */}

      {/* ── RIGHT: History + Setup Guide ──────────────────────────────── */}
      <div className="flex flex-col gap-4">

      {/* ═══════════════════════════════════════════════════════════════════
          ALERT HISTORY
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}>

        <SectionHeader
          icon={History}
          title="Alert History"
          open={historyOpen}
          onClick={() => setHistoryOpen((v) => !v)}
          badge={history.length > 0 && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{ background: TG_BLUE2, color: TG_BLUE, border: `1px solid ${TG_BLUE3}` }}>
              {Math.min(history.length, 10)}/{history.length}
            </span>
          )}
          right={todayCount > 0 && (
            <span className="text-[10px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
              {todayCount} today
            </span>
          )}
        />

        {historyOpen && (
          <div className="px-4 pb-4 flex flex-col gap-2" style={{ borderTop: "1px solid var(--app-border-0)" }}>
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 rounded-xl"
                style={{ color: "var(--app-text-dimmer)" }}>
                <History style={{ width: 22, height: 22, opacity: 0.35 }} />
                <span className="text-xs">
                  {configLoading ? "Loading…" : chatOk ? "No alerts sent yet" : "Complete setup to start receiving alerts"}
                </span>
              </div>
            ) : (
              history.slice(-10).map((ev, i) => <HistoryRow key={i} ev={ev} now={now} />)
            )}
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          BOT SETUP GUIDE
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="rounded-xl overflow-hidden"
        style={{ background: "var(--app-surface-1)", border: `1px solid ${chatOk ? "var(--app-border-0)" : "var(--app-warning-border)"}` }}>

        <SectionHeader
          icon={Bot}
          title="Bot Setup Guide"
          open={setupOpen}
          onClick={() => setSetupOpen((v) => !v)}
          badge={
            chatOk
              ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: "var(--app-success-soft)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}>
                  CONNECTED
                </span>
              : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: "var(--app-warning-soft)", color: "var(--app-warning)", border: "1px solid var(--app-warning-border)" }}>
                  ACTION NEEDED
                </span>
          }
        />

        {setupOpen && (
          <div className="px-5 pb-5 flex flex-col gap-3" style={{ borderTop: "1px solid var(--app-border-0)" }}>
            <SetupStep n={1} done={false}
              text="Telegram mein @BotFather search karo aur /newbot type karo" />
            <SetupStep n={2} done={false}
              text="Bot ka naam aur username do — BotFather ek token dega" />
            <SetupStep n={3} done={tokenOk}
              text={<>Token Replit Secrets mein <code style={{ background: "var(--app-surface-2)", padding: "1px 5px", borderRadius: 4, fontFamily: "monospace", fontSize: 11, color: TG_BLUE }}>TELEGRAM_BOT_TOKEN</code> ke naam se save karo</>} />
            <SetupStep n={4} done={tokenOk}
              text="Server restart karo (ya niche button dabao — token runtime pe load ho jaata hai)" />
            <SetupStep n={5} done={false}
              text="Apne naye bot ko Telegram mein koi bhi message bhejo (jaise 'hi')" />
            <SetupStep n={6} done={chatOk}
              text="Auto-detect Chat ID button dabao — ID automatically detect aur save ho jayegi" />

            {tokenOk && !chatOk && (
              <button
                onClick={handleDetect}
                disabled={detectStatus === "detecting"}
                className="mt-2 flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-bold w-full"
                style={{
                  background: TG_BLUE2, color: TG_BLUE,
                  border: `1px solid ${TG_BLUE3}`, cursor: "pointer",
                  transition: "all 0.18s",
                }}>
                {detectStatus === "detecting"
                  ? <><Loader2 style={{ width: 15, height: 15, animation: "spin 1s linear infinite" }} /> Detecting…</>
                  : detectStatus === "ok"
                  ? <><CheckCircle2 style={{ width: 15, height: 15, color: "var(--app-success)" }} /> Chat ID Detected!</>
                  : <><RefreshCw style={{ width: 15, height: 15 }} /> Auto-detect Chat ID</>
                }
              </button>
            )}
            {detectStatus === "error" && detectError && (
              <span className="text-[10px] px-1" style={{ color: "var(--app-danger)" }}>{detectError.slice(0, 160)}</span>
            )}
          </div>
        )}
      </div>

      </div>{/* end RIGHT column */}
      </div>{/* end 2-col grid */}

    </div>
  );
}
