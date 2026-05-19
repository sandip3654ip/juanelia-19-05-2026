import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { SpotHedgeCard }       from "@/components/SpotHedgeCard";
import { CardErrorBoundary }   from "@/components/ErrorBoundary";
import { PriceChartModal }     from "@/components/PriceChartModal";
import { ExchangeIcon }        from "@/components/ExchangeIcon";
import { loadSpotDefaults, saveSpotDefaults } from "@/lib/spotDefaults";
import { ChevronLeft, ChevronRight, AlertTriangle, RefreshCw, ChevronDown, Search, X } from "lucide-react";

const PAGE_SIZE     = 20;
const ALL_EXCHANGES = ["binance", "bybit", "kucoin", "bitget"];
const RANGE_HOURS   = { "4H": 4, "8H": 8, "12H": 12, "24H": 24 };

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtAge(ms) {
  if (ms == null) return null;
  if (ms < 1000)  return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function ageColor(ms, isRest) {
  if (ms == null) return "var(--app-text-muted)";
  if (isRest)     return "var(--app-warning)";
  if (ms < 500)   return "var(--app-success)";
  if (ms < 3000)  return "var(--app-warning)";
  return "var(--app-danger)";
}
function ageBg(ms, isRest) {
  if (isRest)    return "var(--app-warning-soft)";
  if (ms < 500)  return "var(--app-success-soft)";
  if (ms < 3000) return "var(--app-warning-soft)";
  return "var(--app-danger-soft)";
}
function ageBorder(ms, isRest) {
  if (isRest)    return "var(--app-warning-border)";
  if (ms < 500)  return "var(--app-success-border)";
  if (ms < 3000) return "var(--app-warning-border)";
  return "var(--app-danger-border)";
}

function useLiveTick(intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function InlineError({ message, onRetry }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px", borderRadius: 8,
      background: "var(--app-danger-soft)", border: "1px solid var(--app-danger)",
      fontSize: 12, color: "var(--app-danger)",
    }}>
      <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry && (
        <button onClick={onRetry} style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700,
          cursor: "pointer", background: "transparent",
          border: "1px solid var(--app-danger)", color: "var(--app-danger)",
        }}>
          <RefreshCw style={{ width: 11, height: 11 }} /> Retry
        </button>
      )}
    </div>
  );
}

// Filter sparkline array to only data within the last N hours
function filterSpkByRange(data, hours) {
  if (!data || !data.length) return data;
  const cutoff = Date.now() - hours * 3_600_000;
  const result = data.filter((d) => d.ts >= cutoff);
  return result.length >= 2 ? result : data; // fallback to full data if too few pts
}

// ── Custom dropdown that looks like a <select> but supports icons ─────────────
function ExchangeDropdown({ label, value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const anyMode = value === "any";

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {label && (
        <span className="text-[9px] font-semibold" style={{ color: "var(--app-text-dim)" }}>{label}</span>
      )}
      <div ref={ref} style={{ position: "relative" }}>
        {/* Trigger */}
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-bold"
          style={{
            background: "var(--app-surface-2)",
            border: `1px solid ${anyMode ? "var(--app-warning-border)" : "var(--app-success-border)"}`,
            color:  anyMode ? "var(--app-warning)" : "var(--app-success)",
            cursor: "pointer",
            minWidth: 88,
          }}
        >
          {value === "any" ? (
            <span style={{ flex: 1 }}>Any</span>
          ) : (
            <>
              <ExchangeIcon name={value} size={13} />
              <span style={{ flex: 1, textTransform: "capitalize" }}>{value}</span>
            </>
          )}
          <ChevronDown size={10} style={{ opacity: 0.6, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
        </button>

        {/* Dropdown list */}
        {open && (
          <div
            style={{
              position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200,
              background: "var(--app-surface-2)",
              border: "1px solid var(--app-border-1)",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              minWidth: "100%",
              overflow: "hidden",
            }}
          >
            {options.map((ex) => {
              const isSelected = value === ex;
              return (
                <button
                  key={ex}
                  onClick={() => { onChange(ex); setOpen(false); }}
                  className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-[11px] font-bold"
                  style={{
                    background: isSelected ? "var(--app-success-soft)" : "transparent",
                    color:      isSelected ? "var(--app-success)"      : "var(--app-text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    borderBottom: "1px solid var(--app-border-0)",
                  }}
                >
                  {ex === "any" ? (
                    <span>Any</span>
                  ) : (
                    <>
                      <ExchangeIcon name={ex} size={13} />
                      <span style={{ textTransform: "capitalize" }}>{ex}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main tab ─────────────────────────────────────────────────────────────────

export function SpotHedgeScannerTab({
  spotOpportunities = [],
  spotStatus,
  targetedNetProfit = 1.0,
  onTargetedNetProfitChange,
}) {
  // ── Token search ──────────────────────────────────────────────────────────
  const [tokenSearch, setTokenSearch] = useState("");
  const searchInputRef = useRef(null);

  // ── Pair filter state ─────────────────────────────────────────────────────
  const [exchA, setExchA] = useState("any");
  const [exchB, setExchB] = useState("any");

  const anyMode = exchA === "any" || exchB === "any";

  const handleExchA = useCallback((v) => {
    setExchA(v);
    if (v !== "any" && v === exchB) {
      const other = ALL_EXCHANGES.find((e) => e !== v);
      setExchB(other ?? ALL_EXCHANGES[1]);
    }
  }, [exchB]);

  const handleExchB = useCallback((v) => {
    setExchB(v);
    if (v !== "any" && v === exchA) {
      const other = ALL_EXCHANGES.find((e) => e !== v);
      setExchA(other ?? ALL_EXCHANGES[0]);
    }
  }, [exchA]);

  // ── Peak mode toggle — "spread" | "net" ───────────────────────────────────
  const [peakMode, setPeakMode] = useState("spread");
  // ── Peak filter — only show chips crossing targetedNetProfit ───────────────
  const [peakFilterEnabled, setPeakFilterEnabled] = useState(false);

  // ── Chart timeline (affects card sparklines + popup default) ──────────────
  const [chartRange, setChartRange] = useState(() => loadSpotDefaults().hedgeChartRange);

  const handleChartRange = useCallback((r) => {
    setChartRange(r);
    saveSpotDefaults({ hedgeChartRange: r });
  }, []);

  // ── Price source (hidden in any-mode) ─────────────────────────────────────
  const [priceSourceEx, setPriceSourceEx] = useState(null);
  const resolvedSource = priceSourceEx ?? (anyMode ? null : exchA);

  // ── Target net % ──────────────────────────────────────────────────────────
  const [targetInput, setTargetInput] = useState(String(targetedNetProfit));
  useEffect(() => { setTargetInput(String(targetedNetProfit)); }, [targetedNetProfit]);

  const [page, setPage]           = useState(1);
  const [chartModal, setChartModal] = useState(null);

  // Reset to page 1 when search/filters change
  useEffect(() => { setPage(1); }, [tokenSearch, exchA, exchB]);
  const now = useLiveTick(1_000);

  // ── Queries ───────────────────────────────────────────────────────────────
  // Shared query key with SpotArbTab → instant data when switching tabs
  const { data: spotPriceMovementsData } = useQuery({
    queryKey: ["spot-price-movements"],
    queryFn: async () => {
      const res = await fetch("/api/spot/price-movements");
      if (!res.ok) throw new Error(`Price movements fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: 2,
  });

  const {
    data: spotSparklineData,
    isError: sparklineError,
    refetch: refetchSparklines,
  } = useQuery({
    queryKey: ["spot-sparklines"],   // shared key → reuses SpotArb cache instantly
    queryFn: async () => {
      const res = await fetch("/api/spot/sparklines");
      if (!res.ok) throw new Error(`Sparklines fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: 2,
  });

  // Bid-price sparklines — used for SELL side of InlineDualChart (spread = A_ask − B_bid)
  const { data: spotBidSparklineData } = useQuery({
    queryKey: ["spot-sparklines-bid"],
    queryFn: async () => {
      const res = await fetch("/api/spot/sparklines-bid");
      if (!res.ok) throw new Error(`Bid sparklines fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: 2,
  });

  const { data: chartFullData, isLoading: chartFullLoading } = useQuery({
    queryKey: ["spot-sparklines-full", chartModal?.symbol],  // shared key → reuses SpotArb cache
    queryFn: async () => {
      const res = await fetch(`/api/spot/sparklines-full?symbol=${encodeURIComponent(chartModal.symbol)}`);
      if (!res.ok) throw new Error(`Full sparklines fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    enabled: chartModal !== null,
    staleTime: 30_000,
    gcTime:    60_000,
    retry: 1,
  });

  // Bid-price full sparklines for chart modal SELL side
  const { data: chartFullBidData, isLoading: chartFullBidLoading } = useQuery({
    queryKey: ["spot-sparklines-full-bid", chartModal?.symbol],
    queryFn: async () => {
      const res = await fetch(`/api/spot/sparklines-full-bid?symbol=${encodeURIComponent(chartModal.symbol)}`);
      if (!res.ok) throw new Error(`Full bid sparklines fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    enabled: chartModal !== null,
    staleTime: 30_000,
    gcTime:    60_000,
    retry: 1,
  });

  const handleChartClick = useCallback((opp) => {
    setChartModal({
      symbol:       opp.symbol,
      buyExchange:  opp.buyExchange,
      sellExchange: opp.sellExchange,
      fees:         opp.fees ?? {},
      mode:         "spread",
    });
  }, []);

  const handleCrossoverChartClick = useCallback((opp) => {
    setChartModal({
      symbol:       opp.symbol,
      buyExchange:  opp.buyExchange,
      sellExchange: opp.sellExchange,
      fees:         opp.fees ?? {},
      mode:         "crossover",
    });
  }, []);

  // ── Filter & sort ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const searchTerm = tokenSearch.trim().toUpperCase();
    return spotOpportunities
      .filter((o) => {
        if (!(o.buyAsk > 0))  return false;
        if (!(o.sellBid > 0)) return false;
        // Token search
        if (searchTerm && !o.symbol.toUpperCase().includes(searchTerm)) return false;
        // A = BUY exchange, B = SELL exchange (strict direction — no reverse matching)
        if (exchA !== "any" && exchB !== "any") {
          return o.buyExchange === exchA && o.sellExchange === exchB;
        }
        if (exchA !== "any") return o.buyExchange === exchA;   // A=BUY fixed, B=any
        if (exchB !== "any") return o.sellExchange === exchB;  // B=SELL fixed, A=any
        return true; // both any → show all
      })
      .sort((a, b) => {
        if (anyMode) {
          const netA = (a.priceDiffPct ?? 0) - ((a.fees?.buyFeeRate ?? 0.001) + (a.fees?.sellFeeRate ?? 0.001)) * (1 + (a.fees?.feeTaxRate ?? 0)) * 100 - (a.fees?.tdsRate ?? 0.01) * 100;
          const netB = (b.priceDiffPct ?? 0) - ((b.fees?.buyFeeRate ?? 0.001) + (b.fees?.sellFeeRate ?? 0.001)) * (1 + (b.fees?.feeTaxRate ?? 0)) * 100 - (b.fees?.tdsRate ?? 0.01) * 100;
          return netB - netA;
        }
        return (b.priceDiffPct ?? 0) - (a.priceDiffPct ?? 0);
      });
  // tokenSearch MUST be a dep — missing it causes search to lag until next opp refresh
  }, [spotOpportunities, tokenSearch, exchA, exchB, anyMode]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), [filtered.length]);
  const safePage   = useMemo(() => Math.min(page, totalPages), [page, totalPages]);
  const pageOpps   = useMemo(() => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filtered, safePage]);

  const canPrev = safePage > 1;
  const canNext = safePage < totalPages;
  const btnBase = { background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)" };

  const rangeHours = RANGE_HOURS[chartRange] ?? 4;

  // ── Pre-filtered sparkline maps (stable refs) ──────────────────────────────
  // Without memoization, filterSpkByRange() runs inline in JSX for all 12 cards
  // on every parent re-render — including the 1s useLiveTick tick — producing new
  // array references that bypass SpotHedgeCard's React.memo and cause expensive
  // crossoverPeaks recomputation every second for every visible card.
  const filteredBuySparklines = useMemo(() => {
    if (!spotSparklineData) return {};
    const out = {};
    for (const [ex, symMap] of Object.entries(spotSparklineData)) {
      out[ex] = {};
      for (const [sym, data] of Object.entries(symMap)) {
        out[ex][sym] = filterSpkByRange(data, rangeHours);
      }
    }
    return out;
  }, [spotSparklineData, rangeHours]);

  const filteredSellSparklines = useMemo(() => {
    if (!spotBidSparklineData) return {};
    const out = {};
    for (const [ex, symMap] of Object.entries(spotBidSparklineData)) {
      out[ex] = {};
      for (const [sym, data] of Object.entries(symMap)) {
        out[ex][sym] = filterSpkByRange(data, rangeHours);
      }
    }
    return out;
  }, [spotBidSparklineData, rangeHours]);

  // ── Exchange status + filter panel ───────────────────────────────────────
  const exchangePills = (
    <div
      className="rounded-xl p-3 flex flex-col gap-3"
      style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}
    >
      {/* Status row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-widest flex-shrink-0" style={{ color: "var(--app-text-muted)" }}>
          Exchanges
        </span>
        {ALL_EXCHANGES.map((ex) => {
          const exStatus = spotStatus?.exchanges?.find((e) => e.exchange === ex);
          const online   = exStatus?.status === "online";
          const isRest   = exStatus?.dataSource === "rest";
          const ageMs    = online && exStatus?.lastFetchAt ? Math.max(0, now - exStatus.lastFetchAt) : null;
          const label    = isRest ? `REST${ageMs != null ? ` ${fmtAge(ageMs)}` : ""}` : `WS${ageMs != null ? ` ${fmtAge(ageMs)}` : ""}`;
          const col      = ageColor(ageMs, isRest);
          const bg       = ageBg(ageMs, isRest);
          const border   = ageBorder(ageMs, isRest);
          return (
            <div
              key={ex}
              className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full flex items-center gap-1.5"
              style={{
                background: online ? "var(--app-success-soft)" : "var(--app-surface-2)",
                color:      online ? "var(--app-success)"      : "var(--app-text-dimmer)",
                border:     `1px solid ${online ? "var(--app-success-border)" : "var(--app-border-1)"}`,
              }}
            >
              <ExchangeIcon name={ex} size={12} />
              {ex} {online ? "●" : exStatus ? "○" : "·"} {exStatus?.symbolCount ?? "—"}
              {online && (
                <span className="text-[8px] font-bold font-mono px-1 py-0.5 rounded"
                  style={{ background: bg, color: col, border: `1px solid ${border}` }}>
                  {label}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Pair filter row */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-widest flex-shrink-0" style={{ color: "var(--app-text-muted)" }}>
          Pair Filter
        </span>

        {/* BUY exchange (A) */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: "rgba(34,197,94,0.12)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}>
            BUY
          </span>
          <ExchangeDropdown
            value={exchA}
            onChange={handleExchA}
            options={["any", ...ALL_EXCHANGES]}
          />
        </div>

        <span className="text-[10px] font-bold" style={{ color: "var(--app-text-dimmer)" }}>→</span>

        {/* SELL exchange (B) */}
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: "rgba(248,113,113,0.12)", color: "var(--app-danger)", border: "1px solid var(--app-danger-border)" }}>
            SELL
          </span>
          <ExchangeDropdown
            value={exchB}
            onChange={handleExchB}
            options={["any", ...ALL_EXCHANGES.filter((ex) => exchA === "any" || ex !== exchA)]}
          />
        </div>

        <span className="text-[10px]" style={{ color: "var(--app-text-dimmer)" }}>
          {filtered.length} pairs
          {anyMode && <span style={{ color: "var(--app-warning)", fontWeight: 700 }}> · best net first</span>}
        </span>
      </div>

      {/* Price Source — hidden in any-mode */}
      {!anyMode && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-widest flex-shrink-0" style={{ color: "var(--app-text-muted)" }}>
            Price Source
          </span>
          <div className="flex items-center gap-1.5">
            {[exchA, exchB].map((ex, i) => (
              <button
                key={`src-${i}`}
                onClick={() => setPriceSourceEx(resolvedSource === ex ? null : ex)}
                className="flex items-center gap-1 text-[10px] font-bold capitalize px-2.5 py-1 rounded-full"
                style={{
                  background: resolvedSource === ex ? "var(--app-success-soft)"  : "var(--app-surface-2)",
                  color:      resolvedSource === ex ? "var(--app-success)"        : "var(--app-text-muted)",
                  border:     `1px solid ${resolvedSource === ex ? "var(--app-success-border)" : "var(--app-border-1)"}`,
                  cursor: "pointer",
                }}
              >
                <ExchangeIcon name={ex} size={11} />
                {ex}
              </button>
            ))}
          </div>
          <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>mark price for movement &amp; chart</span>
        </div>
      )}

      {/* Peak Mode toggle */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-widest flex-shrink-0" style={{ color: "var(--app-text-muted)" }}>
          Peak Chips
        </span>
        <div className="flex items-center rounded-lg overflow-hidden" style={{ border: "1px solid var(--app-border-1)" }}>
          {[
            { key: "spread", label: "Spread" },
            { key: "net",    label: "Net %" },
          ].map(({ key, label }) => {
            const active = peakMode === key;
            return (
              <button
                key={key}
                onClick={() => { setPeakMode(key); if (key !== "net") setPeakFilterEnabled(false); }}
                className="px-2.5 py-1 text-[10px] font-bold"
                style={{
                  background: active ? "var(--app-success-soft)" : "var(--app-surface-2)",
                  color:      active ? "var(--app-success)"      : "var(--app-text-muted)",
                  borderRight: key === "spread" ? "1px solid var(--app-border-1)" : "none",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>crossover chips value</span>
      </div>

      {/* Target % of Peak Chips filter — only visible when Net% mode is active */}
      {peakMode === "net" && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-widest flex-shrink-0" style={{ color: "var(--app-text-muted)" }}>
            Peak Filter
          </span>
          <button
            onClick={() => setPeakFilterEnabled((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold"
            style={{
              background: peakFilterEnabled ? "var(--app-success-soft)" : "var(--app-surface-2)",
              color:      peakFilterEnabled ? "var(--app-success)"      : "var(--app-text-muted)",
              border:     `1px solid ${peakFilterEnabled ? "var(--app-success-border)" : "var(--app-border-1)"}`,
              cursor: "pointer",
            }}
          >
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: peakFilterEnabled ? "var(--app-success)" : "var(--app-text-dimmer)",
              flexShrink: 0,
            }} />
            Target % Chips
          </button>
          <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>
            {peakFilterEnabled
              ? "net > +" + targetedNetProfit.toFixed(2) + "% or < -" + targetedNetProfit.toFixed(2) + "%"
              : "show all crossover chips"}
          </span>
        </div>
      )}

      {/* Chart Timeline row */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-widest flex-shrink-0" style={{ color: "var(--app-text-muted)" }}>
          Chart Timeline
        </span>
        <div className="flex items-center gap-1">
          {Object.keys(RANGE_HOURS).map((r) => {
            const isActive = chartRange === r;
            return (
              <button
                key={r}
                onClick={() => handleChartRange(r)}
                className="px-2.5 py-1 rounded-lg text-[10px] font-bold"
                style={{
                  background: isActive ? "var(--app-success-soft)" : "var(--app-surface-2)",
                  color:      isActive ? "var(--app-success)"      : "var(--app-text-muted)",
                  border:     `1px solid ${isActive ? "var(--app-success-border)" : "var(--app-border-1)"}`,
                  cursor: "pointer",
                }}
              >
                {r}
              </button>
            );
          })}
        </div>
        <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>card sparklines &amp; popup default</span>
      </div>

      {/* Target Net % */}
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
          Target Net %
        </span>
        <div className="flex items-center h-6 rounded-lg overflow-hidden"
          style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-success-border)" }}>
          <input
            type="number" step="0.1"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
            onBlur={() => {
              const v = parseFloat(targetInput);
              const val = isFinite(v) ? v : 0;
              if (!isFinite(v)) setTargetInput("0");
              onTargetedNetProfitChange?.(val);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = parseFloat(targetInput);
                const val = isFinite(v) ? v : 0;
                if (!isFinite(v)) setTargetInput("0");
                onTargetedNetProfitChange?.(val);
              }
            }}
            className="w-12 h-full px-2 text-xs font-mono font-bold outline-none text-center bg-transparent"
            style={{ color: "var(--app-success)" }}
          />
          <span className="px-1 text-[9px] font-bold h-full flex items-center"
            style={{ borderLeft: "1px solid var(--app-border-1)", color: "var(--app-text-dimmer)", background: "var(--app-surface-1)" }}>
            %
          </span>
        </div>
      </div>
    </div>
  );

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!spotOpportunities.length) {
    return (
      <div className="flex flex-col gap-4">
        {exchangePills}
        <div className="flex items-center justify-center h-48 rounded-xl text-sm"
          style={{ border: "1px dashed var(--app-border-1)", color: "var(--app-text-dim)" }}>
          Fetching spot prices…
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {exchangePills}

      {sparklineError && (
        <InlineError message="Sparkline data unavailable — charts won't show" onRetry={refetchSparklines} />
      )}

      {/* Pagination top */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
        <span className="text-xs font-mono" style={{ color: "var(--app-text-dim)" }}>
          Showing{" "}
          <span style={{ color: "var(--app-text-muted)" }}>
            {filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}
          </span>{" "}
          of{" "}
          <span style={{ color: "var(--app-success)", fontWeight: 700 }}>{filtered.length}</span>{" "}
          pairs &nbsp;·&nbsp;
          <span style={{ color: "var(--app-text-dimmer)" }}>{exchA} ↔ {exchB}</span>
        </span>

        <div className="flex items-center gap-2">
          {/* Token search — inline with page numbers */}
          <div className="relative flex items-center flex-shrink-0">
            <Search size={11} className="absolute left-2 pointer-events-none" style={{ color: "var(--app-text-dimmer)" }} />
            <input
              ref={searchInputRef}
              type="text"
              value={tokenSearch}
              onChange={(e) => setTokenSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setTokenSearch(""); }}
              placeholder="Token…"
              className="h-8 text-[11px] font-mono font-bold rounded-lg pl-6 pr-6 outline-none"
              style={{
                background: tokenSearch ? "var(--app-surface-3, var(--app-surface-2))" : "var(--app-surface-2)",
                border: `1px solid ${tokenSearch ? "var(--app-warning-border, var(--app-success-border))" : "var(--app-border-1)"}`,
                color: "var(--app-text)",
                width: "100px",
              }}
            />
            {tokenSearch && (
              <button
                onClick={() => { setTokenSearch(""); searchInputRef.current?.focus(); }}
                className="absolute right-1.5 flex items-center justify-center"
                style={{ color: "var(--app-text-dimmer)", cursor: "pointer", background: "none", border: "none", padding: 0 }}
              >
                <X size={10} />
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
          <div className="flex items-center gap-1.5">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={!canPrev}
              className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
              style={{ ...btnBase, color: canPrev ? "var(--app-text-muted)" : "var(--app-text-dimmer)", cursor: canPrev ? "pointer" : "not-allowed" }}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
              .reduce((acc, p, idx, arr) => { if (idx > 0 && arr[idx - 1] !== p - 1) acc.push("…"); acc.push(p); return acc; }, [])
              .map((item, idx) => item === "…" ? (
                <span key={`e-${idx}`} className="text-xs px-1 flex-shrink-0" style={{ color: "var(--app-text-dimmer)" }}>…</span>
              ) : (
                <button key={item} onClick={() => setPage(item)}
                  className="flex items-center justify-center w-8 h-8 rounded-lg text-xs font-bold flex-shrink-0"
                  style={{
                    background: safePage === item ? "var(--app-success)" : "var(--app-surface-2)",
                    border:     safePage === item ? "1px solid var(--app-success)" : "1px solid var(--app-border-1)",
                    color:      safePage === item ? "#050f08" : "var(--app-text-muted)",
                    cursor: "pointer",
                    boxShadow: safePage === item ? "0 0 10px var(--app-success-soft)" : "none",
                  }}>
                  {item}
                </button>
              ))}
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={!canNext}
              className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
              style={{ ...btnBase, color: canNext ? "var(--app-text-muted)" : "var(--app-text-dimmer)", cursor: canNext ? "pointer" : "not-allowed" }}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          </div>
        </div>
      </div>

      {/* Cards grid */}
      {filtered.length === 0 ? (
        <div className="flex items-center justify-center h-32 rounded-xl text-sm"
          style={{ border: "1px dashed var(--app-border-1)", color: "var(--app-text-dim)" }}>
          No pairs found for {exchA} ↔ {exchB}. Try a different pair.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {pageOpps.map((opp) => (
            <CardErrorBoundary key={`${opp.symbol}-${opp.buyExchange}-${opp.sellExchange}`}>
              <SpotHedgeCard
                opp={opp}
                priceMovements={spotPriceMovementsData?.[opp.symbol]}
                buySparkline={filteredBuySparklines[opp.buyExchange]?.[opp.symbol]}
                sellSparkline={filteredSellSparklines[opp.sellExchange]?.[opp.symbol]}
                targetedNetProfit={targetedNetProfit}
                onChartClick={() => handleChartClick(opp)}
                onCrossoverClick={() => handleCrossoverChartClick(opp)}
                peakMode={peakMode}
                peakFilterEnabled={peakFilterEnabled}
              />
            </CardErrorBoundary>
          ))}
        </div>
      )}

      {/* Pagination bottom */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={!canPrev}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-semibold uppercase tracking-widest"
            style={{ ...btnBase, color: canPrev ? "var(--app-text-muted)" : "var(--app-text-dimmer)", cursor: canPrev ? "pointer" : "not-allowed" }}>
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <span className="text-xs font-mono" style={{ color: "var(--app-text-dim)" }}>
            Page <span style={{ color: "var(--app-success)", fontWeight: 700 }}>{safePage}</span> / {totalPages}
          </span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={!canNext}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-semibold uppercase tracking-widest"
            style={{ ...btnBase, color: canNext ? "var(--app-text-muted)" : "var(--app-text-dimmer)", cursor: canNext ? "pointer" : "not-allowed" }}>
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Chart Modal */}
      <PriceChartModal
        open={chartModal !== null}
        onClose={() => setChartModal(null)}
        symbol={chartModal?.symbol}
        buyExchange={chartModal?.buyExchange}
        sellExchange={chartModal?.sellExchange}
        buySparkline={
          chartModal
            ? (chartFullData?.[chartModal.buyExchange]
                ?? spotSparklineData?.[chartModal.buyExchange]?.[chartModal.symbol]
                ?? [])
            : []
        }
        sellSparkline={
          chartModal
            ? (chartFullBidData?.[chartModal.sellExchange]
                ?? spotBidSparklineData?.[chartModal.sellExchange]?.[chartModal.symbol]
                ?? [])
            : []
        }
        loading={false}
        fees={chartModal?.fees}
        initialRange={chartRange}
        mode={chartModal?.mode ?? "spread"}
      />
    </div>
  );
}
