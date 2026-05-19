import { useMemo, useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArbitrageCard } from "@/components/ArbitrageCard";
import { ChevronLeft, ChevronRight, AlertTriangle, RefreshCw } from "lucide-react";

const PAGE_SIZE = 12;

// ── Reusable inline error banner ──────────────────────────────────────────

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
        marginBottom: 8,
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

export function ScannerTab({ opportunities, filters, targetedSpread: targetedSpreadProp = 0.5, onTargetedSpreadChange, priceMovements: priceMovementsProp = null }) {
  const { maxSpread = 5, minNetProfit = -1, exchanges = {} } = filters ?? {};
  const [localTargeted, setLocalTargeted] = useState(targetedSpreadProp);
  const targetedSpread = targetedSpreadProp;

  // Use WS-pushed priceMovements when available; fall back to HTTP poll
  const {
    data: priceMovementsHttp,
    isError: priceHistoryError,
    refetch: refetchPriceHistory,
  } = useQuery({
    queryKey: ["scanner-price-movements"],
    queryFn: async () => {
      const res = await fetch("/api/scanner/price-movements");
      if (!res.ok) throw new Error(`Price movements fetch failed (HTTP ${res.status})`);
      return res.json();
    },
    enabled: priceMovementsProp === null,
    refetchInterval: priceMovementsProp === null ? 60_000 : false,
    staleTime: 55_000,
    retry: 2,
  });

  const priceMovementsData = priceMovementsProp ?? priceMovementsHttp;

  const [page, setPage] = useState(1);

  const filteredOpps = useMemo(() => {
    return opportunities.filter((o) => {
      if (exchanges[o.longExchange] === false) return false;
      if (exchanges[o.shortExchange] === false) return false;
      const spreadAbsPct = Math.abs(o.spreadPct ?? 0) * 100;
      if (spreadAbsPct > maxSpread) return false;
      const netProfitPct = (o.netProfit ?? 0) * 100;
      if (netProfitPct < minNetProfit) return false;
      return true;
    });
  }, [opportunities, exchanges, maxSpread, minNetProfit]);

  const prevFiltersRef = useRef(filters);
  useEffect(() => {
    if (prevFiltersRef.current !== filters) {
      setPage(1);
      prevFiltersRef.current = filters;
    }
  }, [filters]);

  const totalPages = Math.max(1, Math.ceil(filteredOpps.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageOpps = filteredOpps.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const emptyBox = (msg) => (
    <div
      className="flex items-center justify-center h-48 rounded-xl text-sm"
      style={{ border: "1px dashed var(--app-border-1)", color: "var(--app-text-dim)" }}
    >
      {msg}
    </div>
  );

  if (!opportunities.length) return emptyBox("Connecting to exchanges — waiting for data…");
  if (!filteredOpps.length) return emptyBox("No opportunities match your scan parameters.");

  const canPrev = safePage > 1;
  const canNext = safePage < totalPages;
  const btnBase = {
    background: "var(--app-surface-2)",
    border: "1px solid var(--app-border-1)",
  };

  return (
    <div className="flex flex-col gap-4">

      {/* ── Price history error (non-blocking — charts just won't show) ── */}
      {priceHistoryError && (
        <InlineError
          message="Price history unavailable — charts won't show movement data"
          onRetry={refetchPriceHistory}
        />
      )}

      {/* ── Pagination bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-0 justify-between">
        <span className="text-xs font-mono" style={{ color: "var(--app-text-dim)" }}>
          Showing{" "}
          <span style={{ color: "var(--app-text-muted)" }}>
            {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredOpps.length)}
          </span>{" "}
          of{" "}
          <span style={{ color: "var(--app-success)", fontWeight: 700 }}>{filteredOpps.length}</span>{" "}
          opportunities
        </span>

        <div className="overflow-x-auto">
        <div className="flex items-center gap-1.5 min-w-0">
          {/* Targeted spread control */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--app-text-dim)" }}>
              Target
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={localTargeted}
              onChange={(e) => { const v = e.target.valueAsNumber; setLocalTargeted(Number.isFinite(v) ? v : 0); }}
              onBlur={() => onTargetedSpreadChange?.(localTargeted)}
              onKeyDown={(e) => e.key === "Enter" && onTargetedSpreadChange?.(localTargeted)}
              className="w-14 h-8 rounded-lg px-2 text-xs font-mono font-bold outline-none text-center"
              style={{
                background: "var(--app-surface-2)",
                border: "1px solid var(--app-success-border)",
                color: "var(--app-success)",
              }}
            />
            <span className="text-[10px] font-semibold" style={{ color: "var(--app-text-dim)" }}>%</span>
          </div>
          <div className="w-px h-5" style={{ background: "var(--app-border-1)" }} />

          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={!canPrev}
            className="flex items-center justify-center w-8 h-8 rounded-lg"
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
                <span key={`ellipsis-${idx}`} className="text-xs px-1" style={{ color: "var(--app-text-dimmer)" }}>…</span>
              ) : (
                <button
                  key={item}
                  onClick={() => setPage(item)}
                  className="flex items-center justify-center w-8 h-8 rounded-lg text-xs font-bold"
                  style={{
                    background: safePage === item ? "var(--app-success)" : "var(--app-surface-2)",
                    border: safePage === item ? "1px solid var(--app-success)" : "1px solid var(--app-border-1)",
                    color: safePage === item ? "#050f08" : "var(--app-text-muted)",
                    cursor: "pointer",
                    boxShadow: safePage === item ? "0 0 10px var(--app-success-soft)" : "none",
                  }}
                >
                  {item}
                </button>
              )
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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
        {pageOpps.map((opp) => (
          <ArbitrageCard
            key={`${opp.symbol}-${opp.longExchange}-${opp.shortExchange}`}
            opp={opp}
            movements={priceMovementsData?.[opp.symbol]}
            targetedSpread={targetedSpread ?? maxSpread}
          />
        ))}
      </div>

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
    </div>
  );
}
