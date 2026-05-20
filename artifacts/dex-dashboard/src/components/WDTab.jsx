import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { CoinIcon } from "@/components/CoinIcon";
import { Search, Copy, Check, ChevronUp, ChevronDown, ArrowDownToLine, ArrowUpFromLine, Loader2, Zap } from "lucide-react";
import { ExchangeIcon } from "@/components/ExchangeIcon";

// ── Config ─────────────────────────────────────────────────────────────────

const ALL_EXCHANGES = ["bybit", "binance", "kucoin", "bitget"];

const EXCHANGE_COLORS = {
  bybit:   "#F7A600",
  binance: "#F0B90B",
  kucoin:  "#24ae8f",
  bitget:  "#00B897",
};

const NET_COLORS = {
  ERC20:    "#627EEA",
  BEP20:    "#F0B90B",
  ARBITRUM: "#28A0F0",
  OPTIMISM: "#FF0420",
  MATIC:    "#8247E5",
  POLYGON:  "#8247E5",
  SOL:      "#9945FF",
  TRC20:    "#E84142",
  AVAX:     "#E84142",
  TON:      "#0088CC",
  BTC:      "#F7931A",
  NEAR:     "#00C08B",
  DOT:      "#E6007A",
  ATOM:     "#6F7390",
  XRP:      "#346AA9",
  ADA:      "#0D61FF",
  LTC:      "#B8B8B8",
  DOGE:     "#C2A633",
  BASE:     "#0052FF",
  ZKSYNC:   "#8B5CF6",
  STARKNET: "#EC4899",
};

function netColor(n) { return NET_COLORS[n] ?? "#8888AA"; }

// ── Helpers ────────────────────────────────────────────────────────────────

function formatFee(amount, coin) {
  if (amount === 0) return "Free";
  const suffix = " " + coin;
  if (amount < 0.000001) return amount.toExponential(2) + suffix;
  if (amount < 0.001)    return amount.toFixed(6) + suffix;
  if (amount < 1)        return amount.toFixed(4) + suffix;
  if (amount < 100)      return amount.toFixed(2) + suffix;
  return amount.toFixed(0) + suffix;
}

function formatMin(amount, coin) {
  if (!amount) return null;
  const suffix = " " + coin;
  if (amount < 0.000001) return amount.toExponential(2) + suffix;
  if (amount < 0.001)    return amount.toFixed(6) + suffix;
  if (amount < 1)        return amount.toFixed(4) + suffix;
  if (amount < 100)      return amount.toFixed(2) + suffix;
  return amount.toFixed(0) + suffix;
}

// ── Network badge ──────────────────────────────────────────────────────────

function NetBadge({ network }) {
  const color = netColor(network);
  return (
    <span
      style={{
        minWidth: 76,
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 20,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.06em",
        background: color + "18",
        color,
        border: `1px solid ${color}44`,
        textAlign: "center",
        flexShrink: 0,
      }}
    >
      {network}
    </span>
  );
}

// ── Copy button ────────────────────────────────────────────────────────────

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      title={copied ? "Copied!" : "Copy"}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: "2px 4px",
        borderRadius: 4,
        color: copied ? "var(--app-success)" : "var(--app-text-dim)",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// ── Deposit network row ────────────────────────────────────────────────────

function DepositRow({ entry, isLast }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 0",
        borderBottom: isLast ? "none" : "1px solid var(--app-border-0)",
      }}
    >
      <NetBadge network={entry.network} />

      <span
        className="font-mono"
        style={{
          fontSize: 12,
          color: "var(--app-text-primary)",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={entry.address}
      >
        {entry.address}
      </span>

      <CopyBtn text={entry.address} />
    </div>
  );
}

// ── Withdrawal network row ─────────────────────────────────────────────────

function WithdrawalRow({ entry, isLast }) {
  const feeColor = entry.withdrawFee === 0 ? "var(--app-success)" : "var(--app-text-primary)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 0",
        borderBottom: isLast ? "none" : "1px solid var(--app-border-0)",
      }}
    >
      <NetBadge network={entry.network} />

      {/* Fee */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--app-text-dim)" }}>
            Fee
          </span>
          <span
            className="font-mono"
            style={{ fontSize: 12, fontWeight: 700, color: feeColor }}
          >
            {formatFee(entry.withdrawFee, entry.coin)}
          </span>
        </div>

        {entry.minWithdraw > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--app-text-dim)" }}>
              Min
            </span>
            <span className="font-mono" style={{ fontSize: 11, color: "var(--app-text-muted)" }}>
              {formatMin(entry.minWithdraw, entry.coin)}
            </span>
          </div>
        )}

        {entry.maxWithdraw && entry.maxWithdraw > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--app-text-dim)" }}>
              Max
            </span>
            <span className="font-mono" style={{ fontSize: 11, color: "var(--app-text-dim)" }}>
              {formatMin(entry.maxWithdraw, entry.coin)}
            </span>
          </div>
        )}
      </div>

      {/* Memo indicator */}
      {entry.requiresMemo && (
        <span style={{
          padding: "1px 6px",
          borderRadius: 4,
          fontSize: 9,
          fontWeight: 700,
          background: "var(--app-warning-soft)",
          color: "var(--app-warning)",
          letterSpacing: "0.04em",
          flexShrink: 0,
        }}>MEMO REQ</span>
      )}

      {/* Bybit static source badge */}
      {entry.source === "static" && (
        <span style={{
          padding: "1px 5px",
          borderRadius: 4,
          fontSize: 9,
          fontWeight: 600,
          background: "var(--app-surface-2)",
          color: "var(--app-text-dim)",
          letterSpacing: "0.04em",
          flexShrink: 0,
        }} title="Bybit withdrawal fee data is from a manually maintained static table">
          ~approx
        </span>
      )}
    </div>
  );
}

// ── Mode Toggle ────────────────────────────────────────────────────────────

function ModeToggle({ mode, onChange }) {
  const options = [
    { value: "deposit",    label: "Deposit",    Icon: ArrowDownToLine },
    { value: "withdrawal", label: "Withdrawal", Icon: ArrowUpFromLine  },
  ];
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: 4,
        borderRadius: 12,
        background: "var(--app-surface-2)",
        border: "1px solid var(--app-border-0)",
        gap: 2,
        flexShrink: 0,
      }}
    >
      {options.map(({ value, label, Icon }) => {
        const active = mode === value;
        const color = value === "deposit" ? "#24ae8f" : "#F87171";
        return (
          <button
            key={value}
            onClick={() => onChange(value)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              borderRadius: 9,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.05em",
              cursor: "pointer",
              transition: "all 0.18s",
              background: active ? color : "transparent",
              color:      active ? "#050f08" : "var(--app-text-dim)",
              border:     active ? `1px solid ${color}` : "1px solid transparent",
              boxShadow:  active ? `0 0 12px ${color}55` : "none",
            }}
          >
            <Icon style={{ width: 13, height: 13 }} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function WDTab() {
  const [mode,     setMode]     = useState("deposit");
  const [exchange, setExchange] = useState("bybit");
  const [search,   setSearch]   = useState("");
  const [sortDir,  setSortDir]  = useState("asc");

  const isDeposit    = mode === "deposit";
  const isWithdrawal = mode === "withdrawal";

  const queryClient = useQueryClient();

  // ── All-exchange refresh progress (single request for all 4 exchanges) ──
  const allProgressQuery = useQuery({
    queryKey: ["refresh-progress-all"],
    queryFn: async () => {
      const res = await fetch("/api/spot/deposit-addresses/refresh/progress/all");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      return Object.values(d).some((p) => p?.running) ? 2000 : false;
    },
    refetchIntervalInBackground: false,
    enabled: isDeposit,
    staleTime: 1000,
  });

  const allProgress = allProgressQuery.data ?? {};
  const anyRunning  = Object.values(allProgress).some((p) => p?.running);

  // Invalidate deposit addresses for each exchange that just finished
  useEffect(() => {
    for (const ex of ALL_EXCHANGES) {
      const prog = allProgress[ex];
      if (prog && !prog.running && prog.finishedAt) {
        queryClient.invalidateQueries({ queryKey: ["deposit-addresses", ex] });
      }
    }
  }, [
    allProgress.bybit?.finishedAt,
    allProgress.binance?.finishedAt,
    allProgress.kucoin?.finishedAt,
    allProgress.bitget?.finishedAt,
  ]);

  // ── Master refresh mutation — fires all 4 exchanges in parallel ──
  const masterRefreshMutation = useMutation({
    mutationFn: async () => {
      await Promise.allSettled(
        ALL_EXCHANGES.map((ex) =>
          fetch(`/api/spot/deposit-addresses/refresh?exchange=${ex}`, { method: "POST" })
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["refresh-progress-all"] });
    },
  });

  // ── All-exchange fees status query (polls all 4 in parallel when withdrawal mode) ──
  const allFeesStatusQuery = useQuery({
    queryKey: ["fees-status-all"],
    queryFn: async () => {
      const res = await fetch("/api/spot/fees/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json(); // { bybit: {...}, binance: {...}, kucoin: {...}, bitget: {...} }
    },
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      return Object.values(d).some((s) => s?.running) ? 2000 : false;
    },
    refetchIntervalInBackground: false,
    enabled: isWithdrawal,
    staleTime: 5_000,
  });

  const allFeesStatus  = allFeesStatusQuery.data ?? {};
  const anyFeesRunning = Object.values(allFeesStatus).some((s) => s?.running);

  // Invalidate withdrawal data for each exchange that just finished
  useEffect(() => {
    for (const ex of ALL_EXCHANGES) {
      if (allFeesStatus[ex]?.finishedAt) {
        queryClient.invalidateQueries({ queryKey: ["withdrawal-fees", ex] });
      }
    }
  }, [
    allFeesStatus.bybit?.finishedAt,
    allFeesStatus.binance?.finishedAt,
    allFeesStatus.kucoin?.finishedAt,
    allFeesStatus.bitget?.finishedAt,
  ]);

  // Per-exchange helpers (for current selected exchange, used in stats bar)
  const feesExSt      = allFeesStatus[exchange] ?? {};
  const feesRunning   = feesExSt.running   ?? false;
  const feesCoinCount = feesExSt.coins     ?? 0;
  const feesFetchedAt = feesExSt.fetchedAt ?? null;

  // ── Master fees refresh mutation — fires all 4 exchanges in parallel ──
  const masterFeesRefreshMutation = useMutation({
    mutationFn: async () => {
      await Promise.allSettled(
        ALL_EXCHANGES.map((ex) =>
          fetch(`/api/spot/fees/refresh?exchange=${ex}`, { method: "POST" })
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fees-status-all"] });
    },
  });

  // ── Deposit addresses query ──
  const depositQuery = useQuery({
    queryKey: ["deposit-addresses", exchange],
    queryFn: async () => {
      const res = await fetch(`/api/spot/deposit-addresses?exchange=${exchange}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime:       5 * 60 * 1000,
    gcTime:          15 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    enabled: isDeposit,
    retry: 2,
  });

  // ── Withdrawal fees query ──
  const withdrawalQuery = useQuery({
    queryKey: ["withdrawal-fees", exchange],
    queryFn: async () => {
      const res = await fetch(`/api/spot/withdrawal-fees?exchange=${exchange}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime:       12 * 60 * 60 * 1000,
    gcTime:          12 * 60 * 60 * 1000,
    refetchInterval: 12 * 60 * 60 * 1000,
    enabled: isWithdrawal,
    retry: 2,
  });

  const activeQuery = isDeposit ? depositQuery : withdrawalQuery;
  const { isLoading, isError } = activeQuery;

  const exColor = EXCHANGE_COLORS[exchange] ?? "var(--app-success)";

  // ── Group deposit addresses by coin ──
  // Memo/tag-required entries are already filtered by the backend,
  // but apply a client-side guard as well so stale cache never shows them.
  const depositCoinMap = useMemo(() => {
    const addresses = depositQuery.data?.addresses ?? {};
    const map = {};
    for (const entry of Object.values(addresses)) {
      if (entry.tag !== null && entry.tag !== undefined && entry.tag !== "") continue; // memo-required → skip
      if (!map[entry.coin]) map[entry.coin] = [];
      map[entry.coin].push(entry);
    }
    return map;
  }, [depositQuery.data]);

  // ── Group withdrawal fees by coin ──
  const withdrawalCoinMap = useMemo(() => {
    const fees = withdrawalQuery.data?.fees ?? {};
    const map = {};
    for (const entry of Object.values(fees)) {
      if (!map[entry.coin]) map[entry.coin] = [];
      map[entry.coin].push(entry);
    }
    return map;
  }, [withdrawalQuery.data]);

  const coinMap = isDeposit ? depositCoinMap : withdrawalCoinMap;

  // ── Search ──
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const entries = Object.entries(coinMap);
    if (!q) return entries;
    return entries.filter(([coin, nets]) =>
      coin.toLowerCase().includes(q) ||
      nets.some((e) =>
        e.network?.toLowerCase().includes(q) ||
        (isDeposit
          ? (e.address?.toLowerCase().includes(q) || e.chainId?.toLowerCase().includes(q))
          : (e.chainId?.toLowerCase().includes(q))
        )
      )
    );
  }, [coinMap, search, isDeposit]);

  // ── Sort ──
  const sorted = useMemo(() =>
    [...filtered].sort(([a], [b]) =>
      sortDir === "asc" ? a.localeCompare(b) : b.localeCompare(a),
    ),
  [filtered, sortDir]);

  // ── Stats ──
  const depositMeta      = depositQuery.data?.meta ?? {};
  const withdrawalMeta   = withdrawalQuery.data?.meta ?? {};
  const totalNetworks    = isDeposit
    ? Object.values(depositQuery.data?.addresses ?? {}).length
    : Object.keys(withdrawalQuery.data?.fees ?? {}).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Controls row ── */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>

        {/* Deposit/Withdrawal toggle */}
        <ModeToggle mode={mode} onChange={(m) => { setMode(m); setSearch(""); }} />

        {/* Search */}
        <div style={{ position: "relative", flex: 1, minWidth: 140, maxWidth: 340 }}>
          <Search
            style={{
              position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
              width: 15, height: 15, color: "var(--app-text-dim)", pointerEvents: "none",
            }}
          />
          <Input
            placeholder={isDeposit ? "Search coin, network, address…" : "Search coin, network…"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 32 }}
          />
        </div>

        {/* Exchange pills */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 4,
            padding: "6px 10px",
            borderRadius: 12,
            background: "var(--app-surface-2)",
            border: "1px solid var(--app-border-0)",
          }}
        >
          <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--app-text-muted)", marginRight: 4, flexShrink: 0 }}>
            Exchange
          </span>
          {ALL_EXCHANGES.map((ex) => {
            const active = exchange === ex;
            const c = EXCHANGE_COLORS[ex];
            return (
              <button
                key={ex}
                onClick={() => setExchange(ex)}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "4px 10px",
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  cursor: "pointer",
                  transition: "all 0.15s",
                  background: active ? `${c}28` : "transparent",
                  color:      active ? c : "var(--app-text-dim)",
                  border:     active ? `1px solid ${c}99` : "1px solid var(--app-border-1)",
                  boxShadow:  active ? `0 0 10px ${c}44` : "none",
                  flexShrink: 0,
                }}
              >
                <ExchangeIcon name={ex} size={14} />
                {ex}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Stats bar ── */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 20,
          padding: "13px 20px",
          borderRadius: 10,
          background: "var(--app-surface-1)",
          border: "1px solid var(--app-border-0)",
          fontSize: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 8, height: 8, borderRadius: "50%", background: exColor,
              boxShadow: `0 0 6px ${exColor}`, display: "inline-block", flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: exColor }}>
            {exchange}
          </span>
        </div>

        {/* Mode label */}
        <span style={{
          padding: "2px 8px",
          borderRadius: 6,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.07em",
          background: isDeposit ? "#24ae8f22" : "#F8717122",
          color: isDeposit ? "#24ae8f" : "#F87171",
          border: isDeposit ? "1px solid #24ae8f44" : "1px solid #F8717144",
        }}>
          {isDeposit ? "DEPOSIT" : "WITHDRAWAL"}
        </span>

        <span style={{ color: "var(--app-text-muted)" }}>
          <span style={{ fontWeight: 700, color: "var(--app-success)", fontSize: 14 }}>
            {Object.keys(coinMap).length}
          </span>
          {" "}coins
        </span>
        <span style={{ color: "var(--app-text-muted)" }}>
          <span style={{ fontWeight: 700, color: "var(--app-success)", fontSize: 14 }}>
            {totalNetworks}
          </span>
          {" "}networks total
        </span>

        {search && (
          <span style={{ color: "var(--app-text-dim)" }}>
            →{" "}
            <span style={{ fontWeight: 700, color: "var(--app-warning)" }}>{sorted.length}</span>
            {" "}matching
          </span>
        )}

        {depositMeta.isRefreshing && isDeposit && (
          <span style={{ fontSize: 10, color: "var(--app-warning)", animation: "pulse 2s infinite" }}>
            Refreshing…
          </span>
        )}

        {isDeposit && depositMeta.fetchedAt && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--app-text-dim)", fontFamily: "monospace" }}>
            Updated: {new Date(depositMeta.fetchedAt).toLocaleString()}
          </span>
        )}
        {isWithdrawal && withdrawalMeta.generatedAt && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--app-text-dim)", fontFamily: "monospace" }}>
            Generated: {new Date(withdrawalMeta.generatedAt).toLocaleString()}
          </span>
        )}

        {/* Bybit withdrawal data source note */}
        {isWithdrawal && exchange === "bybit" && (
          <span style={{ fontSize: 10, color: "var(--app-text-dim)", fontStyle: "italic" }}>
            ⚠ Bybit fees: static table (~approx)
          </span>
        )}
      </div>

      {/* ── Master deposit address refresh banner ── */}
      {isDeposit && (() => {
        const etaMap = { bybit: "~2m", binance: "~9m", kucoin: "~9m", bitget: "~3m" };
        const allDone = ALL_EXCHANGES.every((ex) => (allProgress[ex]?.addrCount ?? 0) > 10);
        const bannerBg  = anyRunning ? "rgba(100,200,140,0.05)" : !allDone ? "#F8717108" : "var(--app-surface-1)";
        const bannerBdr = anyRunning ? "rgba(100,200,140,0.3)"  : !allDone ? "#F8717133" : "var(--app-border-0)";

        return (
          <div style={{ borderRadius: 12, background: bannerBg, border: `1px solid ${bannerBdr}`, overflow: "hidden" }}>

            {/* Header row */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 12, padding: "14px 18px",
              borderBottom: "1px solid var(--app-border-0)",
              background: "var(--app-surface-1)",
            }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {anyRunning
                    ? <Loader2 style={{ width: 15, height: 15, color: "var(--app-success)", animation: "spin 1s linear infinite" }} />
                    : <Zap style={{ width: 15, height: 15, color: "var(--app-success)" }} />
                  }
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--app-text-bright)" }}>
                    Deposit Address Sync
                  </span>
                  {anyRunning && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                      background: "rgba(100,200,140,0.12)", color: "var(--app-success)",
                      border: "1px solid rgba(100,200,140,0.3)", letterSpacing: "0.06em",
                    }}>
                      RUNNING
                    </span>
                  )}
                  {!anyRunning && allDone && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                      background: "rgba(100,200,140,0.08)", color: "var(--app-success)",
                      border: "1px solid rgba(100,200,140,0.2)", letterSpacing: "0.06em",
                    }}>
                      SYNCED
                    </span>
                  )}
                </div>
                {/* Next auto-refresh info */}
                {(() => {
                  const nextRaw = depositQuery.data?.meta?.nextAutoRefreshAt;
                  if (!nextRaw) return null;
                  const nextDate = new Date(nextRaw);
                  const nowIST  = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
                  const nextIST = new Date(nextDate.getTime() + 5.5 * 60 * 60 * 1000);
                  const diffMs  = nextDate.getTime() - Date.now();
                  const diffHr  = Math.floor(diffMs / 3_600_000);
                  const diffMin = Math.floor((diffMs % 3_600_000) / 60_000);
                  const isToday = nowIST.toDateString() === nextIST.toDateString();
                  const dayLabel = isToday ? "Today" : "Tomorrow";
                  const etaLabel = diffHr > 0 ? `${diffHr}h ${diffMin}m` : `${diffMin}m`;
                  // Format actual IST time (e.g. "3:45 PM")
                  const h24  = nextIST.getUTCHours();
                  const mins = nextIST.getUTCMinutes().toString().padStart(2, "0");
                  const ampm = h24 >= 12 ? "PM" : "AM";
                  const h12  = h24 % 12 || 12;
                  const timeLabel = `${h12}:${mins} ${ampm} IST`;
                  return (
                    <span style={{ fontSize: 10, color: "var(--app-text-dim)", paddingLeft: 23 }}>
                      Auto-refresh: {dayLabel} {timeLabel} &nbsp;·&nbsp; in {etaLabel}
                    </span>
                  );
                })()}
              </div>

              {/* ── MASTER REFRESH BUTTON ── */}
              <button
                onClick={() => masterRefreshMutation.mutate()}
                disabled={anyRunning || masterRefreshMutation.isPending}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "8px 18px", borderRadius: 8,
                  fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
                  cursor: anyRunning ? "not-allowed" : "pointer",
                  background: anyRunning ? "var(--app-surface-2)" : "var(--app-success)",
                  color: anyRunning ? "var(--app-text-dim)" : "#050f08",
                  border: "none",
                  opacity: anyRunning ? 0.65 : 1,
                  transition: "all 0.18s",
                  flexShrink: 0,
                  boxShadow: anyRunning ? "none" : "0 4px 14px rgba(0,0,0,0.25)",
                }}
              >
                {anyRunning || masterRefreshMutation.isPending
                  ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Syncing…</>
                  : <><Zap style={{ width: 13, height: 13 }} /> Refresh All</>
                }
              </button>
            </div>

            {/* Per-exchange progress grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 0 }}>
              {ALL_EXCHANGES.map((ex, i) => {
                const prog     = allProgress[ex];
                const c        = EXCHANGE_COLORS[ex] ?? "#24ae8f";
                const running  = prog?.running ?? false;
                const finished = !running && !!prog?.finishedAt;
                const count    = prog?.addrCount ?? 0;
                const isFresh  = count > 10;
                const done     = prog?.done ?? 0;
                const total    = prog?.total ?? 0;
                const pct      = total > 0 ? Math.round((done / total) * 100) : 0;
                const isLast   = i === ALL_EXCHANGES.length - 1;

                return (
                  <div key={ex} style={{
                    padding: "14px 16px",
                    borderRight: isLast ? "none" : "1px solid var(--app-border-0)",
                    display: "flex", flexDirection: "column", gap: 8,
                  }}>
                    {/* Exchange name */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <ExchangeIcon name={ex} size={16} />
                        <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.07em", color: c }}>
                          {ex}
                        </span>
                      </div>
                      {running && <Loader2 style={{ width: 11, height: 11, color: c, animation: "spin 1s linear infinite" }} />}
                      {finished && <span style={{ fontSize: 10, color: "var(--app-success)" }}>✓</span>}
                    </div>

                    {/* Address count */}
                    <div>
                      <span style={{ fontSize: 20, fontWeight: 800, fontFamily: "monospace", color: isFresh ? "var(--app-text-bright)" : "#F87171" }}>
                        {count}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--app-text-dimmer)", marginLeft: 4 }}>addr</span>
                    </div>

                    {/* Progress bar (when running) */}
                    {running && total > 0 ? (
                      <div>
                        <div style={{ height: 4, borderRadius: 2, background: "var(--app-surface-2)", overflow: "hidden" }}>
                          <div style={{
                            height: "100%", borderRadius: 2, width: `${pct}%`,
                            background: `linear-gradient(90deg, ${c}, ${c}bb)`,
                            transition: "width 0.5s ease",
                            boxShadow: `0 0 6px ${c}88`,
                          }} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                          <span style={{ fontSize: 10, color: "var(--app-text-dimmer)" }}>{done}/{total}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, color: c }}>{pct}%</span>
                        </div>
                      </div>
                    ) : !isFresh && !running ? (
                      <span style={{ fontSize: 10, color: "#F87171aa" }}>
                        Not fetched · {etaMap[ex]}
                      </span>
                    ) : finished ? (
                      <span style={{ fontSize: 10, color: "var(--app-success)" }}>
                        ✓ {prog.fetched} fetched{ex === "kucoin" && prog.generated ? ` · +${prog.generated}` : ""}
                      </span>
                    ) : (
                      <span style={{ fontSize: 10, color: "var(--app-text-dimmer)" }}>Ready</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Withdrawal fees master refresh banner ── */}
      {isWithdrawal && (() => {
        const allSynced = ALL_EXCHANGES.every((ex) => (allFeesStatus[ex]?.coins ?? 0) > 0);
        const bannerBg  = anyFeesRunning ? "rgba(248,113,113,0.05)" : !allSynced ? "#F8717108" : "var(--app-surface-1)";
        const bannerBdr = anyFeesRunning ? "rgba(248,113,113,0.30)" : !allSynced ? "#F8717133" : "var(--app-border-0)";

        return (
          <div style={{ borderRadius: 12, background: bannerBg, border: `1px solid ${bannerBdr}`, overflow: "hidden" }}>

            {/* Header row */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 12, padding: "14px 18px",
              borderBottom: "1px solid var(--app-border-0)",
              background: "var(--app-surface-1)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {anyFeesRunning
                  ? <Loader2 style={{ width: 15, height: 15, color: "#F87171", animation: "spin 1s linear infinite" }} />
                  : <Zap style={{ width: 15, height: 15, color: "#F87171" }} />
                }
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--app-text-bright)" }}>
                  Withdrawal Fees Sync
                </span>
                {anyFeesRunning && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                    background: "rgba(248,113,113,0.12)", color: "#F87171",
                    border: "1px solid rgba(248,113,113,0.3)", letterSpacing: "0.06em",
                  }}>
                    RUNNING
                  </span>
                )}
                {!anyFeesRunning && allSynced && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                    background: "rgba(100,200,140,0.08)", color: "var(--app-success)",
                    border: "1px solid rgba(100,200,140,0.2)", letterSpacing: "0.06em",
                  }}>
                    SYNCED
                  </span>
                )}
              </div>

              {/* ── MASTER REFRESH BUTTON ── */}
              <button
                onClick={() => masterFeesRefreshMutation.mutate()}
                disabled={anyFeesRunning || masterFeesRefreshMutation.isPending}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "8px 18px", borderRadius: 8,
                  fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
                  cursor: anyFeesRunning ? "not-allowed" : "pointer",
                  background: anyFeesRunning ? "var(--app-surface-2)" : "#F87171",
                  color: anyFeesRunning ? "var(--app-text-dim)" : "#1a0000",
                  border: "none",
                  opacity: anyFeesRunning ? 0.65 : 1,
                  transition: "all 0.18s",
                  flexShrink: 0,
                  boxShadow: anyFeesRunning ? "none" : "0 4px 14px rgba(248,113,113,0.35)",
                }}
              >
                {anyFeesRunning || masterFeesRefreshMutation.isPending
                  ? <><Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> Syncing…</>
                  : <><Zap style={{ width: 13, height: 13 }} /> Refresh All</>
                }
              </button>
            </div>

            {/* Per-exchange status grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 0 }}>
              {ALL_EXCHANGES.map((ex, i) => {
                const st       = allFeesStatus[ex] ?? {};
                const c        = EXCHANGE_COLORS[ex] ?? "#F87171";
                const running  = st.running ?? false;
                const coins    = st.coins   ?? 0;
                const isFresh  = coins > 0;
                const isLast   = i === ALL_EXCHANGES.length - 1;
                const updStr   = st.fetchedAt
                  ? new Date(st.fetchedAt).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })
                  : null;

                return (
                  <div key={ex} style={{
                    padding: "14px 16px",
                    borderRight: isLast ? "none" : "1px solid var(--app-border-0)",
                    display: "flex", flexDirection: "column", gap: 8,
                  }}>
                    {/* Exchange name */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <ExchangeIcon name={ex} size={16} />
                        <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.07em", color: c }}>
                          {ex}
                        </span>
                      </div>
                      {running && <Loader2 style={{ width: 11, height: 11, color: c, animation: "spin 1s linear infinite" }} />}
                    </div>

                    {/* Coin count */}
                    <div>
                      <span style={{ fontSize: 20, fontWeight: 800, fontFamily: "monospace", color: isFresh ? "var(--app-text-bright)" : "#F87171" }}>
                        {coins}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--app-text-dimmer)", marginLeft: 4 }}>coins</span>
                    </div>

                    {/* Status line */}
                    {running ? (
                      <span style={{ fontSize: 10, color: c, animation: "pulse 2s infinite" }}>Refreshing…</span>
                    ) : st.error ? (
                      <span style={{ fontSize: 10, color: "#F87171aa" }} title={st.error}>Error</span>
                    ) : updStr ? (
                      <span style={{ fontSize: 10, color: "var(--app-text-dim)", fontFamily: "monospace" }}>{updStr}</span>
                    ) : (
                      <span style={{ fontSize: 10, color: "#F87171aa" }}>Not fetched</span>
                    )}

                    {/* Bybit note */}
                    {ex === "bybit" && (
                      <span style={{ fontSize: 9, color: "var(--app-text-dimmer)", fontStyle: "italic" }}>~approx (static)</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Table card ── */}
      <Card style={{ overflow: "hidden" }}>

        {/* Header */}
        <div
          style={{
            padding: "14px 20px",
            borderBottom: "1px solid var(--app-border-0)",
            background: "var(--app-surface-1)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: exColor, boxShadow: `0 0 6px ${exColor}`, flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: 14, color: "var(--app-text-bright)", textTransform: "capitalize" }}>
            {exchange} — {isDeposit ? "Deposit Addresses" : "Withdrawal Fees"}
          </span>
        </div>

        {/* Loading / Error */}
        {isLoading && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--app-text-muted)", fontSize: 13 }}>
            {isDeposit ? "Loading deposit addresses…" : "Loading withdrawal fees…"}
          </div>
        )}
        {isError && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--app-danger)", fontSize: 13 }}>
            Failed to load. Check API server.
          </div>
        )}

        {!isLoading && !isError && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--app-surface-1)", borderBottom: "1px solid var(--app-border-0)" }}>
                  <th
                    onClick={() => setSortDir((d) => d === "asc" ? "desc" : "asc")}
                    style={{
                      width: 140,
                      padding: "13px 20px",
                      textAlign: "left",
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                      color: "var(--app-text-muted)",
                      cursor: "pointer",
                      userSelect: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Coin{" "}
                    {sortDir === "asc"
                      ? <ChevronUp   style={{ display: "inline", width: 12, height: 12, color: "var(--app-success)" }} />
                      : <ChevronDown style={{ display: "inline", width: 12, height: 12, color: "var(--app-success)" }} />}
                  </th>
                  <th
                    style={{
                      padding: "13px 20px",
                      textAlign: "left",
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                      color: "var(--app-text-muted)",
                    }}
                  >
                    {isDeposit
                      ? "Network · Deposit Address · Memo"
                      : "Network · Withdrawal Fee · Min Amount"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(([coin, entries], idx) => {
                  const nets = [...entries].sort((a, b) =>
                    isDeposit
                      ? a.network.localeCompare(b.network)
                      : a.withdrawFee - b.withdrawFee
                  );
                  const isEven = idx % 2 === 0;
                  return (
                    <tr
                      key={coin}
                      style={{
                        background: isEven ? "transparent" : "var(--app-surface-1)",
                        borderBottom: "1px solid var(--app-border-0)",
                        verticalAlign: "top",
                      }}
                    >
                      {/* Coin cell */}
                      <td style={{ padding: "14px 20px", verticalAlign: "middle", whiteSpace: "nowrap", width: 140 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <CoinIcon symbol={coin} size={24} />
                          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--app-text-bright)" }}>
                            {coin}
                          </span>
                        </div>
                      </td>

                      {/* Networks cell */}
                      <td style={{ padding: "4px 20px" }}>
                        {nets.map((entry, i) =>
                          isDeposit
                            ? <DepositRow    key={entry.network + i} entry={entry} isLast={i === nets.length - 1} />
                            : <WithdrawalRow key={entry.network + i} entry={entry} isLast={i === nets.length - 1} />
                        )}
                      </td>
                    </tr>
                  );
                })}

                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={2} style={{ padding: 40, textAlign: "center", color: "var(--app-text-muted)" }}>
                      {search ? `No results for "${search}"` : "No data found"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p style={{ fontSize: 11, textAlign: "center", color: "var(--app-text-dim)", margin: 0 }}>
        {isDeposit
          ? "Always verify on exchange before sending funds · Deposit addresses auto-refresh every hour at :00 IST"
          : "Withdrawal fees change frequently — always confirm on exchange before withdrawing · Fees refresh every 12h"}
      </p>
    </div>
  );
}
