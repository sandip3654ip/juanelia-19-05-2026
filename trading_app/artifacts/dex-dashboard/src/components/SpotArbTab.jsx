import { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { SpotArbCard }            from "@/components/SpotArbCard";
import { CardErrorBoundary }     from "@/components/ErrorBoundary";
import { BotPanel }              from "@/components/BotPanel";
import { PriceChartModal }       from "@/components/PriceChartModal";
import { computeProjectedProfit } from "@/lib/projectedProfit";
import { ChevronLeft, ChevronRight, AlertTriangle, RefreshCw } from "lucide-react";

const PAGE_SIZE = 12;
const ALL_EXCHANGES = ["binance", "bybit", "kucoin", "bitget"];

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

// ── Inline error banner ────────────────────────────────────────────────────

function InlineError({ message, onRetry }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        borderRadius: 8,
        background: "var(--app-danger-soft)",
        border: "1px solid var(--app-danger)",
        fontSize: 12,
        color: "var(--app-danger)",
      }}
    >
      <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 10px",
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            background: "transparent",
            border: "1px solid var(--app-danger)",
            color: "var(--app-danger)",
          }}
        >
          <RefreshCw style={{ width: 11, height: 11 }} />
          Retry
        </button>
      )}
    </div>
  );
}

export function SpotArbTab({ spotOpportunities = [], spotStatus, targetedNetProfit = 1.0, onTargetedNetProfitChange, initialTradeAmount = 100, initialMinTimesHit = 0 }) {
  const [tradeAmount, setTradeAmount]               = useState(initialTradeAmount);
  const [tradeAmountInput, setTradeAmountInput]     = useState(String(initialTradeAmount));
  const [targetInput, setTargetInput]               = useState(String(targetedNetProfit));
  const [minTimesHit, setMinTimesHit]               = useState(initialMinTimesHit);
  const [minTimesHitInput, setMinTimesHitInput]     = useState(String(initialMinTimesHit));

  useEffect(() => {
    setTradeAmount(initialTradeAmount);
    setTradeAmountInput(String(initialTradeAmount));
  }, [initialTradeAmount]);

  useEffect(() => {
    setMinTimesHit(initialMinTimesHit);
    setMinTimesHitInput(String(initialMinTimesHit));
  }, [initialMinTimesHit]);

  useEffect(() => {
    setTargetInput(String(targetedNetProfit));
  }, [targetedNetProfit]);

  const [activeExchanges, setActiveExchanges]       = useState(() => new Set(ALL_EXCHANGES));
  const [page, setPage] = useState(1);
  const [chartModal, setChartModal]                 = useState(null);
  const now = useLiveTick(1_000);

  const {
    data: spotPriceMovementsData,
    isError: priceHistoryError,
    refetch: refetchPriceHistory,
  } = useQuery({
    queryKey: ["spot-price-movements"],
    queryFn: async () => {
      const res = await fetch("/api/spot/price-movements");
      if (!res.ok) throw new Error(`Spot price movements fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: 2,
  });

  const { data: spotExchangeMovementsData } = useQuery({
    queryKey: ["spot-price-movements-by-exchange"],
    queryFn: async () => {
      const res = await fetch("/api/spot/price-movements-by-exchange");
      if (!res.ok) throw new Error(`Exchange movements fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: 2,
  });

  const { data: spotProfitHistoryData } = useQuery({
    queryKey: ["spot-profit-history"],
    queryFn: async () => {
      const res = await fetch("/api/spot/profit-history");
      if (!res.ok) throw new Error(`Profit history fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: 2,
  });

  // Mini sparklines for card charts (~60 pts, fast)
  const { data: spotSparklineData } = useQuery({
    queryKey: ["spot-sparklines"],
    queryFn: async () => {
      const res = await fetch("/api/spot/sparklines");
      if (!res.ok) throw new Error(`Sparklines fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: 2,
  });

  // Full-resolution sparklines for the chart modal — fetched on-demand per symbol
  const { data: chartFullData } = useQuery({
    queryKey: ["spot-sparklines-full", chartModal?.symbol],
    queryFn: async () => {
      const res = await fetch(`/api/spot/sparklines-full?symbol=${encodeURIComponent(chartModal.symbol)}`);
      if (!res.ok) throw new Error(`Full sparklines fetch failed (HTTP ${res.status})`);
      return res.json(); // { binance: [{ts,price},...], bybit: [...], ... }
    },
    enabled: chartModal !== null,
    staleTime: 30_000,
    gcTime:    60_000,
    retry: 1,
  });

  const { data: botStatusData } = useQuery({
    queryKey: ["bot-status"],
    queryFn: async () => {
      const res = await fetch("/api/bot/status");
      if (!res.ok) throw new Error(`Bot status fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    refetchInterval: 700,
    staleTime: 600,
    retry: 1,
  });

  const botCfg = botStatusData?.config ?? null;

  const toggleExchange = (ex) => {
    setActiveExchanges((prev) => {
      const next = new Set(prev);
      if (next.has(ex)) next.delete(ex);
      else next.add(ex);
      return next;
    });
    setPage(1);
  };

  const handleChartClick = useCallback((opp) => {
    setChartModal({
      symbol:       opp.symbol,
      buyExchange:  opp.buyExchange,
      sellExchange: opp.sellExchange,
    });
  }, []);

  const filtered = useMemo(() => {
    const list = spotOpportunities.filter((o) => {
      if (!activeExchanges.has(o.buyExchange))  return false;
      if (!activeExchanges.has(o.sellExchange)) return false;
      if (minTimesHit > 0 && (o.profitTimesHit ?? 0) < minTimesHit) return false;
      if (!(o.buyAsk  > 0)) return false;
      if (!(o.sellBid > 0)) return false;
      return true;
    });
    return list
      .map((o) => ({ o, proj: computeProjectedProfit(o, tradeAmount).profit }))
      .sort((a, b) => b.proj - a.proj)
      .map(({ o }) => o);
  }, [spotOpportunities, activeExchanges, tradeAmount, minTimesHit]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageOpps   = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const btnBase = {
    background: "var(--app-surface-2)",
    border: "1px solid var(--app-border-1)",
  };

  const canPrev = safePage > 1;
  const canNext = safePage < totalPages;

  // ── Exchange pills ──────────────────────────────────────────────────────
  const exchangePills = (
    <div
      className="rounded-xl p-3 flex flex-col gap-3"
      style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="text-[10px] font-bold uppercase tracking-widest flex-shrink-0"
          style={{ color: "var(--app-text-muted)" }}
        >
          Exchanges
        </span>
        {ALL_EXCHANGES.map((ex) => {
          const exStatus = spotStatus?.exchanges?.find((e) => e.exchange === ex);
          const online   = exStatus?.status === "online";
          const isRest   = exStatus?.dataSource === "rest";
          const active   = activeExchanges.has(ex);
          const ageMs    = online && exStatus?.lastFetchAt
            ? Math.max(0, now - exStatus.lastFetchAt)
            : null;
          const label    = isRest
            ? `REST${ageMs != null ? ` ${fmtAge(ageMs)}` : ""}`
            : `WS${ageMs != null ? ` ${fmtAge(ageMs)}` : ""}`;
          const col    = ageColor(ageMs, isRest);
          const bg     = ageBg(ageMs, isRest);
          const border = ageBorder(ageMs, isRest);

          return (
            <button
              key={ex}
              onClick={() => toggleExchange(ex)}
              className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full transition-all flex items-center gap-1.5"
              style={{
                background: active ? (online ? "var(--app-success-soft)" : "var(--app-danger-soft)") : "var(--app-surface-2)",
                color:      active ? (online ? "var(--app-success)"      : "var(--app-danger)")      : "var(--app-text-dimmer)",
                border:     `1px solid ${active ? (online ? "var(--app-success-border)" : "var(--app-danger-border)") : "var(--app-border-1)"}`,
                cursor: "pointer",
                opacity: active ? 1 : 0.5,
              }}
              title={!online && exStatus ? `${ex} is offline` : undefined}
            >
              {ex} {online ? "●" : exStatus ? "○" : "·"} {exStatus?.symbolCount ?? "—"}
              {online && (
                <span
                  className="text-[8px] font-bold font-mono px-1 py-0.5 rounded"
                  style={{ background: bg, color: col, border: `1px solid ${border}` }}
                >
                  {label}
                </span>
              )}
              {!online && exStatus && (
                <span
                  className="text-[8px] font-bold font-mono px-1 py-0.5 rounded"
                  style={{ background: "var(--app-danger-soft)", color: "var(--app-danger)", border: "1px solid var(--app-danger-border)" }}
                >
                  OFFLINE
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Filters row ── */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] font-bold uppercase tracking-widest"
            style={{ color: "var(--app-text-muted)" }}
            title="Trade size in USDT — projected profit is calculated against this"
          >
            Trade Amount
          </span>
          <div
            className="flex items-center h-7 rounded-lg overflow-hidden"
            style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-warning-border)" }}
          >
            <span className="px-2 text-[10px] font-bold" style={{ color: "var(--app-text-muted)" }}>$</span>
            <input
              type="number"
              step="10"
              min="0"
              value={tradeAmountInput}
              onChange={(e) => setTradeAmountInput(e.target.value)}
              onBlur={() => {
                const v = parseFloat(tradeAmountInput);
                setTradeAmount(isFinite(v) && v >= 0 ? v : 100);
                if (!isFinite(v) || v < 0) setTradeAmountInput("100");
                setPage(1);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = parseFloat(tradeAmountInput);
                  setTradeAmount(isFinite(v) && v >= 0 ? v : 100);
                  if (!isFinite(v) || v < 0) setTradeAmountInput("100");
                  setPage(1);
                }
              }}
              className="w-20 h-full px-1 text-xs font-mono font-bold outline-none text-center bg-transparent"
              style={{ color: "var(--app-warning)" }}
            />
          </div>
        </div>

        <span className="text-[10px]" style={{ color: "var(--app-text-dimmer)" }}>
          {filtered.length} opportunities
        </span>
      </div>
    </div>
  );

  // ── Loading / empty states ─────────────────────────────────────────────
  if (!spotOpportunities.length) {
    const anyOnline = spotStatus?.exchanges?.some((e) => e.status === "online");
    const allOffline = spotStatus?.exchanges?.length > 0 &&
      spotStatus.exchanges.every((e) => e.status !== "online");

    let emptyMsg = "Fetching spot prices from exchanges…";
    if (anyOnline)  emptyMsg = "No arbitrage opportunities found across active exchanges.";
    if (allOffline) emptyMsg = "All spot exchanges are currently offline. Retrying…";

    return (
      <div className="flex flex-col gap-4">
        {exchangePills}
        {priceHistoryError && (
          <InlineError
            message="Spot price history unavailable — movement charts won't show"
            onRetry={refetchPriceHistory}
          />
        )}
        <div
          className="flex items-center justify-center h-48 rounded-xl text-sm"
          style={{ border: "1px dashed var(--app-border-1)", color: "var(--app-text-dim)" }}
        >
          {emptyMsg}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {exchangePills}

      {/* ── Trading Bot Panel ── */}
      <BotPanel />

      {/* Price history error (non-blocking) */}
      {priceHistoryError && (
        <InlineError
          message="Spot price history unavailable — movement charts won't show"
          onRetry={refetchPriceHistory}
        />
      )}

      {/* ── Pagination bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-mono" style={{ color: "var(--app-text-dim)" }}>
            Showing{" "}
            <span style={{ color: "var(--app-text-muted)" }}>
              {filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}
            </span>{" "}
            of{" "}
            <span style={{ color: "var(--app-success)", fontWeight: 700 }}>{filtered.length}</span>{" "}
            opportunities
          </span>

          {/* Target Net % threshold input */}
          <div className="flex items-center gap-1.5">
            <span
              className="text-[9px] font-bold uppercase tracking-widest"
              style={{ color: "var(--app-text-muted)" }}
              title="Count how many times in the last 4 hours net profit reached this % — shown as 'Times Hit' on each card"
            >
              Target
            </span>
            <div
              className="flex items-center h-6 rounded-lg overflow-hidden"
              style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-success-border)" }}
            >
              <input
                type="number"
                step="0.1"
                min="0"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                onBlur={() => {
                  const v = parseFloat(targetInput);
                  const val = isFinite(v) && v >= 0 ? v : 0.5;
                  if (!isFinite(v) || v < 0) setTargetInput("0.5");
                  onTargetedNetProfitChange?.(val);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = parseFloat(targetInput);
                    const val = isFinite(v) && v >= 0 ? v : 0.5;
                    if (!isFinite(v) || v < 0) setTargetInput("0.5");
                    onTargetedNetProfitChange?.(val);
                  }
                }}
                className="w-12 h-full px-2 text-xs font-mono font-bold outline-none text-center bg-transparent"
                style={{ color: "var(--app-success)" }}
              />
              <span
                className="px-1 text-[9px] font-bold h-full flex items-center"
                style={{ borderLeft: "1px solid var(--app-border-1)", color: "var(--app-text-dimmer)", background: "var(--app-surface-1)" }}
              >
                %
              </span>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={!canPrev}
            className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
            style={{ ...btnBase, color: canPrev ? "var(--app-text-muted)" : "var(--app-text-dimmer)", cursor: canPrev ? "pointer" : "not-allowed" }}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
            .reduce((acc, p, idx, arr) => {
              if (idx > 0 && arr[idx - 1] !== p - 1) acc.push("…");
              acc.push(p);
              return acc;
            }, [])
            .map((item, idx) =>
              item === "…" ? (
                <span key={`e-${idx}`} className="text-xs px-1 flex-shrink-0" style={{ color: "var(--app-text-dimmer)" }}>…</span>
              ) : (
                <button
                  key={item}
                  onClick={() => setPage(item)}
                  className="flex items-center justify-center w-8 h-8 rounded-lg text-xs font-bold flex-shrink-0"
                  style={{
                    background: safePage === item ? "var(--app-success)" : "var(--app-surface-2)",
                    border:     safePage === item ? "1px solid var(--app-success)" : "1px solid var(--app-border-1)",
                    color:      safePage === item ? "#050f08" : "var(--app-text-muted)",
                    cursor: "pointer",
                    boxShadow: safePage === item ? "0 0 10px var(--app-success-soft)" : "none",
                  }}
                >
                  {item}
                </button>
              ),
            )}

          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={!canNext}
            className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
            style={{ ...btnBase, color: canNext ? "var(--app-text-muted)" : "var(--app-text-dimmer)", cursor: canNext ? "pointer" : "not-allowed" }}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        </div>
      </div>

      {/* ── Cards grid ── */}
      {filtered.length === 0 ? (
        <div
          className="flex items-center justify-center h-32 rounded-xl text-sm"
          style={{ border: "1px dashed var(--app-border-1)", color: "var(--app-text-dim)" }}
        >
          No opportunities match your filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {pageOpps.map((opp) => (
            <CardErrorBoundary key={`${opp.symbol}-${opp.buyExchange}-${opp.sellExchange}`}>
              <SpotArbCard
                opp={opp}
                tradeAmount={tradeAmount}
                movements={
                  spotExchangeMovementsData?.[opp.sellExchange]?.[opp.symbol]
                  ?? spotPriceMovementsData?.[opp.symbol]
                }
                buySparkline={spotSparklineData?.[opp.buyExchange]?.[opp.symbol]}
                sellSparkline={spotSparklineData?.[opp.sellExchange]?.[opp.symbol]}
                targetedNetProfit={targetedNetProfit}
                botMinNetProfitPct={botCfg?.minNetProfitPct ?? null}
                botMinTimesHit={botCfg?.minTimesHit ?? null}
                botTakeProfitPct={botCfg?.takeProfitPct ?? null}
                botMaxMovementPct={botCfg?.maxMovementPct ?? null}
                botPriceMovementWindow={botCfg?.priceMovementWindow ?? null}
                onChartClick={() => handleChartClick(opp)}
              />
            </CardErrorBoundary>
          ))}
        </div>
      )}

      {/* ── Bottom pagination ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={!canPrev}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-semibold uppercase tracking-widest"
            style={{ ...btnBase, color: canPrev ? "var(--app-text-muted)" : "var(--app-text-dimmer)", cursor: canPrev ? "pointer" : "not-allowed" }}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </button>
          <span className="text-xs font-mono" style={{ color: "var(--app-text-dim)" }}>
            Page <span style={{ color: "var(--app-success)", fontWeight: 700 }}>{safePage}</span> / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={!canNext}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-semibold uppercase tracking-widest"
            style={{ ...btnBase, color: canNext ? "var(--app-text-muted)" : "var(--app-text-dimmer)", cursor: canNext ? "pointer" : "not-allowed" }}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Price Chart Modal ── */}
      <PriceChartModal
        open={chartModal !== null}
        onClose={() => setChartModal(null)}
        symbol={chartModal?.symbol}
        buyExchange={chartModal?.buyExchange}
        sellExchange={chartModal?.sellExchange}
        buySparkline={
          chartModal
            ? (chartFullData?.[chartModal.buyExchange] ?? spotSparklineData?.[chartModal.buyExchange]?.[chartModal.symbol] ?? [])
            : []
        }
        sellSparkline={
          chartModal
            ? (chartFullData?.[chartModal.sellExchange] ?? spotSparklineData?.[chartModal.sellExchange]?.[chartModal.symbol] ?? [])
            : []
        }
        profitSeries={
          chartModal
            ? (spotProfitHistoryData?.[`${chartModal.symbol}|${chartModal.buyExchange}|${chartModal.sellExchange}`] ?? [])
            : []
        }
      />
    </div>
  );
}
