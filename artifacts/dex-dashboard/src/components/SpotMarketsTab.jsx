import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { CoinIcon } from "@/components/CoinIcon";
import { ExchangeIcon } from "@/components/ExchangeIcon";
import {
  Search, ChevronUp, ChevronDown, ChevronsUpDown,
  ChevronLeft, ChevronRight, Wifi, WifiOff,
} from "lucide-react";

// ── Exchange config ────────────────────────────────────────────────────────────

const EXCHANGES = [
  { id: "binance", label: "Binance", color: "#F0B90B" },
  { id: "bybit",   label: "Bybit",   color: "#F7A600" },
  { id: "kucoin",  label: "KuCoin",  color: "#24ae8f" },
  { id: "bitget",  label: "Bitget",  color: "#00B897" },
];

const PAGE_SIZE = 50;

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtPrice(v) {
  if (v == null || !isFinite(v)) return null;
  if (v >= 10_000)  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (v >= 1_000)   return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1)       return v.toFixed(4);
  if (v >= 0.01)    return v.toFixed(5);
  if (v >= 0.0001)  return v.toFixed(6);
  return v.toPrecision(4);
}

function countExchanges(row) {
  return EXCHANGES.filter((e) => row[e.id] != null).length;
}

function SortIcon({ col, sortKey, sortDir }) {
  if (sortKey !== col) return <ChevronsUpDown className="inline ml-0.5 h-2.5 w-2.5 opacity-30" />;
  return sortDir === "asc"
    ? <ChevronUp   className="inline ml-0.5 h-2.5 w-2.5" style={{ color: "var(--app-success)" }} />
    : <ChevronDown className="inline ml-0.5 h-2.5 w-2.5" style={{ color: "var(--app-success)" }} />;
}

// ── Price cell ─────────────────────────────────────────────────────────────────

function PriceCell({ quote, isBestBid, isBestAsk, active, color }) {
  if (!active) return null;
  if (!quote) {
    return (
      <td className="text-center py-3 px-2"
        style={{ color: "var(--app-text-dimmer)", borderLeft: "1px solid var(--app-border-0)" }}>
        <span className="text-xs">—</span>
      </td>
    );
  }
  const bidStr = fmtPrice(quote.bid);
  const askStr = fmtPrice(quote.ask);
  return (
    <td className="py-2.5 px-4 font-mono"
      style={{ borderLeft: "1px solid var(--app-border-0)", minWidth: 140 }}>
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-bold leading-none"
          style={{ color: isBestBid ? "var(--app-success)" : "var(--app-text-muted)" }}>
          {bidStr}
          {isBestBid && (
            <span className="ml-1 text-[8px] font-extrabold uppercase tracking-wider px-1 py-0.5 rounded"
              style={{ background: "var(--app-success-soft)", color: "var(--app-success)" }}>
              best
            </span>
          )}
        </span>
        <span className="text-[10px] leading-none"
          style={{ color: isBestAsk ? "#f87171" : "var(--app-text-dimmer)" }}>
          {askStr}
          {isBestAsk && (
            <span className="ml-1 text-[8px] font-extrabold uppercase tracking-wider px-1 py-0.5 rounded"
              style={{ background: "rgba(248,113,113,0.12)", color: "#f87171" }}>
              low
            </span>
          )}
        </span>
      </div>
    </td>
  );
}

// ── Exchange column header ─────────────────────────────────────────────────────

function ExchangeHeader({ ex, active, checked, onToggle, sortKey, sortDir, onSort, online }) {
  if (!active) return null;
  return (
    <th className="py-0 px-0 text-left select-none"
      style={{ borderLeft: "1px solid var(--app-border-0)", minWidth: 140 }}>

      {/* Exchange name + toggle */}
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-4 py-3 transition-all"
        style={{
          background:  checked ? `${ex.color}12` : "transparent",
          borderBottom: `2px solid ${checked ? ex.color : "transparent"}`,
        }}>

        {/* Icon */}
        <span className="flex-shrink-0 rounded-full overflow-hidden"
          style={{
            width: 22, height: 22,
            boxShadow: checked ? `0 0 0 2px ${ex.color}55` : "none",
          }}>
          <ExchangeIcon name={ex.id} size={22} />
        </span>

        {/* Label + status */}
        <div className="flex flex-col items-start gap-0 min-w-0">
          <span className="text-[11px] font-extrabold uppercase tracking-wider leading-none"
            style={{ color: checked ? ex.color : "var(--app-text-dimmer)" }}>
            {ex.label}
          </span>
          <span className="text-[8px] font-bold leading-none mt-0.5 flex items-center gap-0.5"
            style={{ color: online ? "var(--app-success)" : "var(--app-text-dimmer)" }}>
            {online
              ? <><span className="inline-block w-1 h-1 rounded-full bg-green-400" />live</>
              : <><span className="inline-block w-1 h-1 rounded-full" style={{ background: "var(--app-text-dimmer)" }} />offline</>
            }
          </span>
        </div>
      </button>

      {/* Bid / Ask sort row */}
      <div className="flex items-center gap-3 px-4 pb-2.5">
        <button onClick={() => onSort(`${ex.id}_bid`)}
          className="text-[9px] font-bold uppercase tracking-wider flex items-center gap-0.5"
          style={{ color: "var(--app-success)", cursor: "pointer", background: "transparent" }}>
          Bid
          <SortIcon col={`${ex.id}_bid`} sortKey={sortKey} sortDir={sortDir} />
        </button>
        <span style={{ color: "var(--app-border-1)", fontSize: 10 }}>/</span>
        <button onClick={() => onSort(`${ex.id}_ask`)}
          className="text-[9px] font-bold uppercase tracking-wider flex items-center gap-0.5"
          style={{ color: "#f87171", cursor: "pointer", background: "transparent" }}>
          Ask
          <SortIcon col={`${ex.id}_ask`} sortKey={sortKey} sortDir={sortDir} />
        </button>
      </div>
    </th>
  );
}

// ── Coverage dots ──────────────────────────────────────────────────────────────

function CoverageDots({ row }) {
  return (
    <div className="flex items-center gap-0.5 mt-0.5">
      {EXCHANGES.map((ex) => (
        <span key={ex.id} className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: row[ex.id] != null ? ex.color : "var(--app-border-1)" }}
          title={row[ex.id] != null ? ex.label : `Not on ${ex.label}`}
        />
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function SpotMarketsTab({ spotStatus }) {
  const [search,    setSearch]    = useState("");
  const [page,      setPage]      = useState(1);
  const [sortKey,   setSortKey]   = useState(null);
  const [sortDir,   setSortDir]   = useState("asc");
  const [exChecked, setExChecked] = useState(
    () => Object.fromEntries(EXCHANGES.map((e) => [e.id, true]))
  );

  const { data: rows = [], isLoading, dataUpdatedAt } = useQuery({
    queryKey:        ["spot-markets"],
    queryFn:         async () => {
      const r = await fetch("/api/spot/markets");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 700,
    staleTime:       600,
  });

  const activeExchanges = EXCHANGES.filter((e) => exChecked[e.id]);

  const statusMap = useMemo(() =>
    Object.fromEntries((spotStatus?.exchanges ?? []).map((e) => [e.exchange, e]))
  , [spotStatus]);

  // ── Filter + sort ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    // Only coins on 2+ exchanges (regardless of toggle state)
    let result = rows.filter((r) => countExchanges(r) >= 2);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((r) => r.symbol.toLowerCase().includes(q));
    }

    if (!sortKey) return result;

    return [...result].sort((a, b) => {
      if (sortKey === "symbol") {
        return sortDir === "asc"
          ? a.symbol.localeCompare(b.symbol)
          : b.symbol.localeCompare(a.symbol);
      }
      const [exId, field] = sortKey.split("_");
      const av = a[exId]?.[field] ?? -Infinity;
      const bv = b[exId]?.[field] ?? -Infinity;
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [rows, search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const handleSort = (key) => {
    if (sortKey === key) {
      if (sortDir === "asc") setSortDir("desc");
      else { setSortKey(null); setSortDir("asc"); }
    } else {
      setSortKey(key); setSortDir("asc");
    }
    setPage(1);
  };

  const handleSearch = (v) => { setSearch(v); setPage(1); };
  const toggleEx     = (id) => setExChecked((prev) => ({ ...prev, [id]: !prev[id] }));

  function getBests(row) {
    const bids = EXCHANGES.filter((e) => exChecked[e.id] && row[e.id]?.bid > 0).map((e) => ({ ex: e.id, v: row[e.id].bid }));
    const asks = EXCHANGES.filter((e) => exChecked[e.id] && row[e.id]?.ask > 0).map((e) => ({ ex: e.id, v: row[e.id].ask }));
    const bestBidEx = bids.length ? bids.reduce((a, b) => a.v > b.v ? a : b).ex : null;
    const bestAskEx = asks.length ? asks.reduce((a, b) => a.v < b.v ? a : b).ex : null;
    return { bestBidEx, bestAskEx };
  }

  const lastUpdate = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : null;
  const totalAll   = rows.filter((r) => countExchanges(r) >= 2).length;

  return (
    <div className="flex flex-col gap-4">

      {/* ── Header strip ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">

        {/* Search */}
        <div className="relative min-w-[200px] max-w-xs" style={{ flex: "1 1 200px" }}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5"
            style={{ color: "var(--app-text-dimmer)" }} />
          <Input
            placeholder="Search coin…"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>

        {/* Exchange toggles — with real icons */}
        <div className="flex items-center gap-2 flex-wrap">
          {EXCHANGES.map((ex) => {
            const on     = exChecked[ex.id];
            const st     = statusMap[ex.id];
            const online = st?.status === "online";
            return (
              <button
                key={ex.id}
                onClick={() => toggleEx(ex.id)}
                className="flex items-center gap-2 h-9 px-3 rounded-xl text-[11px] font-bold uppercase tracking-wider transition-all"
                style={{
                  background: on ? `${ex.color}15` : "var(--app-surface-1)",
                  border:    `1.5px solid ${on ? ex.color + "60" : "var(--app-border-1)"}`,
                  color:      on ? ex.color : "var(--app-text-dimmer)",
                  boxShadow:  on ? `0 0 10px ${ex.color}20` : "none",
                  opacity:    on ? 1 : 0.6,
                  transition: "all 0.15s ease",
                }}>

                {/* Exchange icon */}
                <span className="rounded-full overflow-hidden flex-shrink-0"
                  style={{ width: 16, height: 16 }}>
                  <ExchangeIcon name={ex.id} size={16} />
                </span>

                {ex.label}

                {/* Online dot */}
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: online ? "var(--app-success)" : "var(--app-border-1)" }} />
              </button>
            );
          })}
        </div>

        {/* Count + timestamp */}
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {isLoading && (
            <span className="text-[10px] animate-pulse" style={{ color: "var(--app-text-dimmer)" }}>
              Updating…
            </span>
          )}
          <span className="text-[11px] font-mono px-2.5 py-1 rounded-lg"
            style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)", color: "var(--app-text-muted)" }}>
            {filtered.length.toLocaleString()}
            {search && ` / ${totalAll}`}
            {" coins"}
            {lastUpdate && <span style={{ color: "var(--app-text-dimmer)" }}> · {lastUpdate}</span>}
          </span>
        </div>
      </div>

      {/* ── Table ─────────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl overflow-hidden"
        style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-1)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--app-surface-2)", borderBottom: "1px solid var(--app-border-1)" }}>

                {/* # */}
                <th className="py-3 px-4 text-left w-12" style={{ verticalAlign: "bottom" }}>
                  <span className="text-[9px] font-bold uppercase tracking-widest pb-2 block"
                    style={{ color: "var(--app-text-dimmer)" }}>#</span>
                </th>

                {/* Coin */}
                <th className="py-3 px-4 text-left cursor-pointer select-none"
                  onClick={() => handleSort("symbol")}
                  style={{ verticalAlign: "bottom" }}>
                  <span className="text-[9px] font-bold uppercase tracking-widest pb-2 flex items-center gap-0.5"
                    style={{ color: "var(--app-text-muted)" }}>
                    Coin
                    <SortIcon col="symbol" sortKey={sortKey} sortDir={sortDir} />
                  </span>
                </th>

                {/* Exchange columns */}
                {EXCHANGES.map((ex) => (
                  <ExchangeHeader
                    key={ex.id}
                    ex={ex}
                    active={exChecked[ex.id]}
                    checked={exChecked[ex.id]}
                    onToggle={() => toggleEx(ex.id)}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                    online={statusMap[ex.id]?.status === "online"}
                  />
                ))}
              </tr>
            </thead>

            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={2 + activeExchanges.length}
                    className="text-center py-16 text-sm"
                    style={{ color: "var(--app-text-dimmer)" }}>
                    {isLoading
                      ? "Loading market data…"
                      : search
                      ? `No coins match "${search}"`
                      : "No data yet"}
                  </td>
                </tr>
              ) : (
                pageRows.map((row, idx) => {
                  const { bestBidEx, bestAskEx } = getBests(row);
                  const globalIdx = (safePage - 1) * PAGE_SIZE + idx + 1;
                  const exCount   = countExchanges(row);
                  return (
                    <tr
                      key={row.symbol}
                      className="transition-colors"
                      style={{
                        borderBottom: "1px solid var(--app-border-0)",
                        background:   "transparent",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--app-surface-2)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      {/* Index */}
                      <td className="py-3 px-4 text-[11px] font-mono tabular-nums"
                        style={{ color: "var(--app-text-dimmer)", width: 48 }}>
                        {globalIdx}
                      </td>

                      {/* Coin */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <CoinIcon symbol={row.symbol} size={22} />
                          <div className="flex flex-col gap-0.5">
                            <span className="font-extrabold text-sm leading-none"
                              style={{ color: "var(--app-text-bright)" }}>
                              {row.symbol}
                            </span>
                            {/* Coverage dots */}
                            <CoverageDots row={row} />
                          </div>
                          {exCount === 4 && (
                            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                              style={{ background: "var(--app-success-soft)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}>
                              4 EX
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Price cells */}
                      {EXCHANGES.map((ex) => (
                        <PriceCell
                          key={ex.id}
                          quote={row[ex.id]}
                          isBestBid={bestBidEx === ex.id}
                          isBestAsk={bestAskEx === ex.id}
                          active={exChecked[ex.id]}
                          color={ex.color}
                        />
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3"
          style={{ borderTop: "1px solid var(--app-border-0)", background: "var(--app-surface-2)" }}>
          <span className="text-[11px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
            {filtered.length === 0
              ? "No results"
              : `${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString()} coins`}
          </span>

          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage === 1}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
                style={{
                  background: safePage === 1 ? "transparent" : "var(--app-surface-1)",
                  border:     "1px solid var(--app-border-1)",
                  color:      safePage === 1 ? "var(--app-text-dimmer)" : "var(--app-text-muted)",
                  cursor:     safePage === 1 ? "default" : "pointer",
                }}>
                <ChevronLeft style={{ width: 14, height: 14 }} />
              </button>

              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
                .reduce((acc, p, i, arr) => {
                  if (i > 0 && p - arr[i - 1] > 1) acc.push("…");
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, i) =>
                  p === "…"
                    ? <span key={`ell-${i}`} className="w-8 text-center text-sm"
                        style={{ color: "var(--app-text-dimmer)" }}>…</span>
                    : (
                      <button key={p} onClick={() => setPage(p)}
                        className="w-8 h-8 rounded-lg text-xs font-bold transition-all"
                        style={{
                          background: p === safePage ? "var(--app-success)" : "var(--app-surface-1)",
                          border:     "1px solid var(--app-border-1)",
                          color:      p === safePage ? "#050f08" : "var(--app-text-muted)",
                          cursor:     "pointer",
                          boxShadow:  p === safePage ? "0 0 8px var(--app-success-strong)" : "none",
                        }}>
                        {p}
                      </button>
                    )
                )}

              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
                style={{
                  background: safePage === totalPages ? "transparent" : "var(--app-surface-1)",
                  border:     "1px solid var(--app-border-1)",
                  color:      safePage === totalPages ? "var(--app-text-dimmer)" : "var(--app-text-muted)",
                  cursor:     safePage === totalPages ? "default" : "pointer",
                }}>
                <ChevronRight style={{ width: 14, height: 14 }} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
