import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { Countdown } from "@/components/Countdown";
import { CoinIcon } from "@/components/CoinIcon";
import { Search, ChevronUp, ChevronDown, ChevronsUpDown, WifiOff, AlertTriangle, Loader2 } from "lucide-react";

const formatFundingRate = (val) => {
  if (val == null || !isFinite(val)) return "—";
  return (val >= 0 ? "+" : "") + (val * 100).toFixed(4) + "%";
};
const formatSpread = (val) => {
  if (val == null || !isFinite(val)) return "—";
  return (val * 100).toFixed(3) + "%";
};
const formatPrice = (val) =>
  val != null
    ? "$" + val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
    : "-";

const COLUMNS = [
  { key: "symbol",        label: "Symbol",           align: "left"  },
  { key: "bestBid",       label: "Best Bid",          align: "right" },
  { key: "bestAsk",       label: "Best Ask",          align: "right" },
  { key: "spreadPct",     label: "Spread",            align: "right" },
  { key: "fundingRate",   label: "Funding Rate",      align: "right" },
  { key: "nextFundingAt", label: "Next Settlement",   align: "right" },
];

function SortIcon({ colKey, sortKey, sortDir }) {
  if (sortKey !== colKey) return <ChevronsUpDown className="inline-block ml-1 h-3 w-3 opacity-30" />;
  return sortDir === "asc"
    ? <ChevronUp   className="inline-block ml-1 h-3 w-3" style={{ color: "var(--app-success)" }} />
    : <ChevronDown className="inline-block ml-1 h-3 w-3" style={{ color: "var(--app-success)" }} />;
}

function ExchangeSection({ exchangeName, marketsData, scannerStatus, search }) {
  const ticks    = marketsData?.[exchangeName] ?? [];
  const exStatus = scannerStatus?.exchanges?.find((e) => e.exchange === exchangeName);
  const isOffline = exStatus?.status === "offline";
  const isDegraded = exStatus?.status === "degraded";

  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  // Stale data: last tick is > 30s old (Vest goes offline silently)
  const isStale =
    ticks.length > 0 &&
    ticks.every((t) => Date.now() - t.receivedAt > 30_000);

  const handleSort = (key) => {
    if (sortKey === key) {
      if (sortDir === "asc") setSortDir("desc");
      else { setSortKey(null); setSortDir("asc"); }
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filteredTicks = useMemo(() => {
    let result = ticks;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((t) => t.symbol.toLowerCase().includes(q));
    }
    if (!sortKey) return result;
    return [...result].sort((a, b) => {
      const av = a[sortKey] ?? (sortKey === "symbol" ? "" : -Infinity);
      const bv = b[sortKey] ?? (sortKey === "symbol" ? "" : -Infinity);
      if (typeof av === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [ticks, search, sortKey, sortDir]);

  // ── Status badge ──────────────────────────────────────────────────────────
  const statusBadge = exStatus ? (
    <Badge
      variant="outline"
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        background:
          exStatus.status === "online"   ? "var(--app-success-soft)"
          : exStatus.status === "degraded" ? "var(--app-warning-soft)"
          : "var(--app-danger-soft)",
        color:
          exStatus.status === "online"   ? "var(--app-success)"
          : exStatus.status === "degraded" ? "var(--app-warning)"
          : "var(--app-danger)",
        border: `1px solid ${
          exStatus.status === "online"   ? "var(--app-success-border)"
          : exStatus.status === "degraded" ? "var(--app-warning-border)"
          : "var(--app-danger-border)"
        }`,
      }}
    >
      {exStatus.status}
    </Badge>
  ) : null;

  // ── Offline / stale state ─────────────────────────────────────────────────
  const showOfflineState = isOffline || (isStale && ticks.length > 0);

  return (
    <Card className="overflow-hidden mb-6 flex flex-col">
      {/* Header */}
      <div className="bg-muted px-4 py-3 border-b flex flex-wrap gap-y-2 justify-between items-center">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-bold text-lg capitalize tracking-tight">{exchangeName}</h2>
          {statusBadge}
          {isDegraded && (
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--app-warning)",
              }}
            >
              <AlertTriangle style={{ width: 12, height: 12 }} />
              Partial data
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {ticks.length > 0 && (
            <span className="text-xs font-mono" style={{ color: "var(--app-text-dim)" }}>
              {filteredTicks.length} / {ticks.length} symbols
            </span>
          )}
          <span className="text-xs text-muted-foreground font-mono">
            {exStatus?.lastDataAt
              ? new Date(exStatus.lastDataAt).toLocaleTimeString()
              : "No data"}
          </span>
        </div>
      </div>

      {/* Offline / stale panel */}
      {showOfflineState ? (
        <div
          style={{
            padding: "40px 24px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            color: "var(--app-text-dim)",
          }}
        >
          <WifiOff style={{ width: 28, height: 28, color: "var(--app-danger)", opacity: 0.7 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--app-text-muted)" }}>
            {exchangeName.toUpperCase()} is offline
          </span>
          <span style={{ fontSize: 12, color: "var(--app-text-dim)", textAlign: "center" }}>
            {isStale
              ? "Data is stale (no updates in >30s) — connection may have dropped"
              : "WebSocket connection lost — retrying automatically"}
          </span>
        </div>
      ) : ticks.length === 0 ? (
        /* No data yet (first connect) */
        <div
          style={{
            padding: "40px 24px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            color: "var(--app-text-dim)",
          }}
        >
          <span style={{ fontSize: 13 }}>
            {exStatus ? "Connecting…" : "Waiting for exchange data…"}
          </span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((col) => (
                  <TableHead
                    key={col.key}
                    className={col.align === "right" ? "text-right" : ""}
                    onClick={() => handleSort(col.key)}
                    style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                  >
                    {col.label}
                    <SortIcon colKey={col.key} sortKey={sortKey} sortDir={sortDir} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTicks.map((t) => (
                <TableRow key={t.symbol}>
                  <TableCell className="font-bold">
                    <div className="flex items-center gap-2">
                      <CoinIcon symbol={t.symbol} size={20} />
                      <span>{t.symbol}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    <AnimatedNumber value={t.bestBid} format={formatPrice} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    <AnimatedNumber value={t.bestAsk} format={formatPrice} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    <AnimatedNumber value={t.spreadPct} format={formatSpread} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    <div className="flex flex-col items-end">
                      <AnimatedNumber
                        value={t.fundingRate}
                        format={formatFundingRate}
                        isPositiveGreen
                      />
                      <span className="text-[10px] text-muted-foreground">
                        /{t.fundingIntervalMs === 14_400_000 ? "4h" : "8h"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    <Countdown targetEpochMs={t.nextFundingAt} />
                  </TableCell>
                </TableRow>
              ))}
              {filteredTicks.length === 0 && ticks.length > 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                    No symbols match &ldquo;{search}&rdquo;
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

const ALL_EXCHANGES = ["pi42", "aster", "delta", "coinswitch"];

export function MarketsTab({ marketsData: wsMd, scannerStatus: wsStatus }) {
  const [search, setSearch] = useState("");
  const [activeExchange, setActiveExchange] = useState("pi42");

  // ── HTTP queries (primary — these always have spreadPct computed) ──────────
  const { data: httpMarkets, isLoading: mkLoading } = useQuery({
    queryKey:        ["markets"],
    queryFn:         async () => {
      const r = await fetch("/api/markets");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json(); // { pi42: [...], aster: [...], delta: [...], coinswitch: [...] }
    },
    refetchInterval: 700,
    staleTime:       600,
  });

  const { data: httpStatus } = useQuery({
    queryKey:        ["scanner-status"],
    queryFn:         async () => {
      const r = await fetch("/api/scanner/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 700,
    staleTime:       600,
  });

  // HTTP is preferred (has spreadPct); WS is fallback
  const marketsData   = httpMarkets ?? wsMd;
  const scannerStatus = httpStatus  ?? wsStatus;

  return (
    <div className="space-y-4">
      {/* ── Search + Exchange chips ── */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative max-w-md flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter symbols…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-markets"
          />
        </div>

        <div
          className="flex items-center gap-1 overflow-x-auto"
          style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)", borderRadius: "10px", padding: "6px 10px" }}
        >
          <span className="text-[10px] font-semibold uppercase tracking-widest mr-2 flex-shrink-0" style={{ color: "var(--app-text-muted)" }}>
            Exchange
          </span>
          {ALL_EXCHANGES.map((ex) => {
            const on  = activeExchange === ex;
            const exStatus = scannerStatus?.exchanges?.find((e) => e.exchange === ex);
            const offline  = exStatus?.status === "offline";
            return (
              <button
                key={ex}
                onClick={() => setActiveExchange(ex)}
                className="px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider transition-all"
                style={{
                  background: on ? "var(--app-success)" : "transparent",
                  color: on ? "#050f08" : offline ? "var(--app-danger)" : "var(--app-exchange-inactive)",
                  border: on
                    ? "1px solid var(--app-success)"
                    : offline
                    ? "1px solid var(--app-danger-border)"
                    : "1px solid var(--app-border-1)",
                  boxShadow: on ? "0 0 8px var(--app-success-strong)" : "none",
                }}
                title={offline ? `${ex} is currently offline` : undefined}
              >
                {ex}
                {offline && !on && (
                  <span style={{ marginLeft: 4, opacity: 0.8 }}>○</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Exchange table ── */}
      <div>
        <ExchangeSection
          key={activeExchange}
          exchangeName={activeExchange}
          marketsData={marketsData}
          scannerStatus={scannerStatus}
          search={search}
        />
      </div>
    </div>
  );
}
