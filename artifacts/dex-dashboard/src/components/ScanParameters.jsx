import { useState, useEffect } from "react";
import { useQuery }           from "@tanstack/react-query";
import { Zap, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

const DEFAULTS = {
  maxSpread: 5,
  minNetProfit: -1,
  exchanges: { pi42: true, aster: true, delta: true, coinswitch: true },
};

// ── Age helpers (same palette as SpotArbTab) ────────────────────────────────

function fmtAge(ms) {
  if (ms == null) return null;
  if (ms < 1000)  return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ageColor(ms) {
  if (ms == null) return "var(--app-text-muted)";
  if (ms < 500)   return "var(--app-success)";
  if (ms < 3000)  return "var(--app-warning)";
  return "var(--app-danger)";
}

function ageBg(ms) {
  if (ms == null) return "var(--app-surface-2)";
  if (ms < 500)   return "var(--app-success-soft)";
  if (ms < 3000)  return "var(--app-warning-soft)";
  return "var(--app-danger-soft)";
}

function ageBorder(ms) {
  if (ms == null) return "var(--app-border-1)";
  if (ms < 500)   return "var(--app-success-border)";
  if (ms < 3000)  return "var(--app-warning-border)";
  return "var(--app-danger-border)";
}

function useLiveTick(intervalMs = 500) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ScanParameters({ filters, onApply, opportunityCount, scannerStatus: scannerStatusProp = null }) {
  const [local, setLocal]       = useState(filters);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 640);
  const now = useLiveTick(1_000);

  // ── Scanner status (exchange health) ──────────────────────────────────────
  // When Dashboard passes status via WS (500 ms cadence), skip own REST poll.
  const { data: scannerStatusRest } = useQuery({
    queryKey: ["scanner-status"],
    queryFn: async () => {
      const res = await fetch("/api/scanner/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: scannerStatusProp === null,
    refetchInterval: scannerStatusProp === null ? 1_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 800,
  });

  const scannerStatus = scannerStatusProp ?? scannerStatusRest;

  const handleReset = () => {
    setLocal(DEFAULTS);
    onApply(DEFAULTS);
    toast.info("Filters reset to defaults");
  };

  const handleApply = () => {
    onApply(local);
    const activeExchanges = Object.values(local.exchanges).filter(Boolean).length;
    toast.success("Filters applied", {
      description:
        opportunityCount != null
          ? `${opportunityCount.toLocaleString()} opportunities across ${activeExchanges} exchange${activeExchanges !== 1 ? "s" : ""}`
          : `Spread ≤ ${local.maxSpread}% · Net profit ≥ ${local.minNetProfit}%`,
      duration: 3000,
    });
    setCollapsed(true);
  };

  const toggleExchange = (ex) => {
    setLocal((prev) => {
      const next = { ...prev, exchanges: { ...prev.exchanges, [ex]: !prev.exchanges[ex] } };
      if (Object.values(next.exchanges).filter(Boolean).length < 2) {
        toast.warning("At least 2 exchanges required for arbitrage");
        return prev;
      }
      return next;
    });
  };

  const activeExCount = Object.values(local.exchanges).filter(Boolean).length;

  return (
    <div
      className="rounded-xl mb-4"
      style={{ background: "var(--app-surface-0)", border: "1px solid var(--app-border-0)" }}
    >
      {/* ── Compact header (always visible) ── */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 gap-3"
        onClick={() => setCollapsed((c) => !c)}
        style={{ borderRadius: "inherit" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Zap className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--app-success)" }} />
          <span className="text-xs font-bold tracking-widest uppercase" style={{ color: "var(--app-success)" }}>
            Scan Parameters
          </span>
          {collapsed && (
            <span className="text-[10px] font-mono truncate hidden sm:block" style={{ color: "var(--app-text-dim)" }}>
              — Spread ≤ {local.maxSpread}% · Net ≥ {local.minNetProfit}% · {activeExCount} exchanges
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {collapsed && opportunityCount != null && (
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded-full tabular-nums"
              style={{ background: "var(--app-success-soft)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}
            >
              {opportunityCount.toLocaleString()}
            </span>
          )}
          {collapsed
            ? <ChevronDown className="h-3.5 w-3.5" style={{ color: "var(--app-text-muted)" }} />
            : <ChevronUp   className="h-3.5 w-3.5" style={{ color: "var(--app-text-muted)" }} />}
        </div>
      </button>

      {/* ── Expanded body ── */}
      {!collapsed && (
        <div className="px-4 pb-4 flex flex-col gap-4" style={{ borderTop: "1px solid var(--app-border-0)" }}>
          {/* Inputs row */}
          <div className="grid grid-cols-2 gap-3 pt-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                Max Spread (%)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={local.maxSpread}
                onChange={(e) => setLocal((p) => ({ ...p, maxSpread: parseFloat(e.target.value) || 0 }))}
                className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none"
                style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-2)", color: "var(--app-text-primary)" }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                Min Net Profit (%)
              </label>
              <input
                type="number"
                step="0.01"
                value={local.minNetProfit}
                onChange={(e) => setLocal((p) => ({ ...p, minNetProfit: parseFloat(e.target.value) || 0 }))}
                className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none"
                style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-2)", color: "var(--app-text-primary)" }}
              />
            </div>
          </div>

          {/* Target Exchanges + Buttons row */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-2">
              <label className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                Target Exchanges
              </label>

              {/* ── Exchange status pills (live WS age + online/offline) ── */}
              <div className="flex flex-wrap gap-2">
                {["pi42", "aster", "delta", "coinswitch"].map((ex) => {
                  const exStatus = scannerStatus?.exchanges?.find((e) => e.exchange === ex);
                  const online   = exStatus?.status === "online";
                  const degraded = exStatus?.status === "degraded";
                  const checked  = local.exchanges[ex];

                  const ageMs = online && exStatus?.lastDataAt != null
                    ? Math.max(0, now - exStatus.lastDataAt)
                    : null;

                  const label = `WS${ageMs != null ? ` ${fmtAge(ageMs)}` : ""}`;
                  const col    = ageColor(ageMs);
                  const bg     = ageBg(ageMs);
                  const border = ageBorder(ageMs);

                  return (
                    <button
                      key={ex}
                      onClick={() => toggleExchange(ex)}
                      className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full transition-all flex items-center gap-1.5"
                      style={{
                        background: checked
                          ? online   ? "var(--app-success-soft)"
                          : degraded ? "var(--app-warning-soft)"
                          :            "var(--app-danger-soft)"
                          : "var(--app-surface-2)",
                        color: checked
                          ? online   ? "var(--app-success)"
                          : degraded ? "var(--app-warning)"
                          :            "var(--app-danger)"
                          : "var(--app-text-dimmer)",
                        border: `1px solid ${
                          checked
                            ? online   ? "var(--app-success-border)"
                            : degraded ? "var(--app-warning-border)"
                            :            "var(--app-danger-border)"
                            : "var(--app-border-1)"
                        }`,
                        cursor:  "pointer",
                        opacity: checked ? 1 : 0.5,
                      }}
                      title={!online && exStatus ? `${ex} is ${exStatus.status}` : undefined}
                    >
                      {/* Checkbox-dot */}
                      <span style={{ fontSize: 8 }}>
                        {online ? "●" : exStatus ? "○" : "·"}
                      </span>

                      {ex}

                      {/* Instrument count */}
                      {exStatus && (
                        <span style={{ opacity: 0.7, fontWeight: 400 }}>
                          {exStatus.instrumentCount}
                        </span>
                      )}

                      {/* WS age badge */}
                      {online && (
                        <span
                          className="text-[8px] font-bold font-mono px-1 py-0.5 rounded"
                          style={{ background: bg, color: col, border: `1px solid ${border}` }}
                        >
                          {label}
                        </span>
                      )}

                      {/* Offline / degraded badge */}
                      {!online && exStatus && (
                        <span
                          className="text-[8px] font-bold font-mono px-1 py-0.5 rounded"
                          style={{
                            background: degraded ? "var(--app-warning-soft)" : "var(--app-danger-soft)",
                            color:      degraded ? "var(--app-warning)"      : "var(--app-danger)",
                            border: `1px solid ${degraded ? "var(--app-warning-border)" : "var(--app-danger-border)"}`,
                          }}
                        >
                          {degraded ? "STALE" : "OFFLINE"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2.5 w-full sm:w-auto">
              <button
                onClick={handleReset}
                className="flex-1 sm:flex-none px-4 py-2.5 rounded-lg text-xs font-semibold uppercase tracking-widest"
                style={{ background: "transparent", border: "1px solid var(--app-border-1)", color: "var(--app-text-muted)" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--app-border-0)"; e.currentTarget.style.background = "var(--app-surface-2)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--app-border-1)"; e.currentTarget.style.background = "transparent"; }}
              >
                Reset
              </button>
              <button
                onClick={handleApply}
                className="flex-1 sm:flex-none px-5 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest"
                style={{ background: "var(--app-success)", color: "#050f08", boxShadow: "0 0 12px var(--app-success-soft)" }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = "0 0 18px var(--app-success-strong)"; e.currentTarget.style.filter = "brightness(0.92)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "0 0 12px var(--app-success-soft)"; e.currentTarget.style.filter = "none"; }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
