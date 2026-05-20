import { useState, useEffect } from "react";
import { useGetWalletBalances } from "@workspace/api-client-react";
import { ExchangeIcon } from "@/components/ExchangeIcon";
import { CoinIcon }     from "@/components/CoinIcon";
import {
  RefreshCw, Wallet, CheckCircle2, XCircle, KeyRound,
  TrendingUp, CircleDollarSign, Lock, ChevronDown, ChevronUp,
} from "lucide-react";

// ── Brand config ───────────────────────────────────────────────────────────

const EXCHANGE_META = {
  binance: { label: "Binance", color: "#F0B90B", glow: "rgba(240,185,11,0.12)", border: "rgba(240,185,11,0.30)" },
  bybit:   { label: "Bybit",   color: "#F7A600", glow: "rgba(247,166,0,0.12)",  border: "rgba(247,166,0,0.30)"  },
  kucoin:  { label: "KuCoin",  color: "#24AE8F", glow: "rgba(36,174,143,0.12)", border: "rgba(36,174,143,0.30)" },
  bitget:  { label: "Bitget",  color: "#00B897", glow: "rgba(0,184,151,0.12)",  border: "rgba(0,184,151,0.30)"  },
};

const ALL_EXCHANGES = ["binance", "bybit", "kucoin", "bitget"];

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtUSDT(v) {
  if (v == null || isNaN(v)) return "$0.0000";
  return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function fmtCoin(v, max = 6) {
  if (v == null || isNaN(v)) return "0";
  if (v >= 1_000_000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (v >= 1)   return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v > 0)    return v.toFixed(max);
  return "0";
}

function fmtAge(ms) {
  if (ms < 60_000)  return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3600_000)}h ago`;
}

// ── Skeleton ───────────────────────────────────────────────────────────────

function Skeleton({ w = "100%", h = 16, radius = 6 }) {
  return (
    <div
      className="animate-pulse"
      style={{
        width: w, height: h, borderRadius: radius,
        background: "var(--app-surface-2)",
      }}
    />
  );
}

// ── Status badge ───────────────────────────────────────────────────────────

function StatusBadge({ status, keyConfigured }) {
  if (status === "ok") {
    return (
      <span
        className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
        style={{ background: "var(--app-success-soft)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}
      >
        <CheckCircle2 className="h-2.5 w-2.5" />
        Connected
      </span>
    );
  }
  if (status === "no_key" || !keyConfigured) {
    return (
      <span
        className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
        style={{ background: "var(--app-surface-2)", color: "var(--app-text-muted)", border: "1px solid var(--app-border-1)" }}
      >
        <KeyRound className="h-2.5 w-2.5" />
        No API Key
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
      style={{ background: "var(--app-danger-soft)", color: "var(--app-danger)", border: "1px solid var(--app-danger-border)" }}
    >
      <XCircle className="h-2.5 w-2.5" />
      Error
    </span>
  );
}

// ── Asset row ──────────────────────────────────────────────────────────────

function AssetRow({ asset }) {
  const hasUSD = asset.usdtValue > 0;
  return (
    <div className="flex items-center gap-2 py-1.5 px-3" style={{ borderTop: "1px solid var(--app-border-0)" }}>
      <CoinIcon symbol={asset.coin} size={16} />
      <span className="text-[11px] font-bold flex-shrink-0 w-16 truncate" style={{ color: "var(--app-text-bright)" }}>
        {asset.coin}
      </span>

      <div className="flex-1 flex flex-col items-end min-w-0">
        <span className="text-[11px] font-mono font-semibold tabular-nums" style={{ color: "var(--app-text-bright)" }}>
          {fmtCoin(asset.free)}
        </span>
        {asset.locked > 0 && (
          <span className="flex items-center gap-0.5 text-[9px] font-mono" style={{ color: "var(--app-text-dim)" }}>
            <Lock className="h-2 w-2" />
            {fmtCoin(asset.locked)} locked
          </span>
        )}
      </div>

      {hasUSD && (
        <span className="text-[11px] font-mono font-semibold tabular-nums flex-shrink-0" style={{ color: "var(--app-text-muted)" }}>
          {fmtUSDT(asset.usdtValue)}
        </span>
      )}
    </div>
  );
}

// ── Exchange card ──────────────────────────────────────────────────────────

function ExchangeCard({ wallet, isLoading }) {
  const [expanded, setExpanded] = useState(false);
  const meta = EXCHANGE_META[wallet?.exchange ?? "binance"];
  const exchange = wallet?.exchange ?? "binance";

  const showAssets  = wallet?.status === "ok" && (wallet.assets?.length ?? 0) > 0;
  const topAssets   = wallet?.assets?.slice(0, expanded ? 50 : 5) ?? [];
  const hiddenCount = (wallet?.assets?.length ?? 0) - 5;

  return (
    <div
      className="rounded-2xl overflow-hidden flex flex-col"
      style={{
        background:   "var(--app-surface-0)",
        border:       `1px solid ${meta.border}`,
        boxShadow:    `0 0 24px ${meta.glow}`,
      }}
    >
      {/* ── Card header ── */}
      <div
        className="px-4 py-3 flex items-center justify-between gap-3"
        style={{
          background:   "var(--app-surface-1)",
          borderBottom: `1px solid ${meta.border}`,
        }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <ExchangeIcon name={exchange} size={28} />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-extrabold tracking-tight leading-tight" style={{ color: meta.color }}>
              {meta.label}
            </span>
            {wallet?.fetchedAt && wallet.status === "ok" && (
              <span className="text-[9px]" style={{ color: "var(--app-text-dim)" }}>
                {fmtAge(Date.now() - wallet.fetchedAt)}
              </span>
            )}
          </div>
        </div>
        <StatusBadge status={wallet?.status} keyConfigured={wallet?.keyConfigured} />
      </div>

      {/* ── Equity rows ── */}
      {isLoading ? (
        <div className="px-4 py-4 flex flex-col gap-3">
          <Skeleton h={32} />
          <Skeleton h={20} w="60%" />
        </div>
      ) : wallet?.status === "ok" ? (
        <div className="px-4 pt-4 pb-3 flex flex-col gap-3">
          {/* Total equity */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>
                Total Equity
              </span>
              <span className="text-2xl font-extrabold font-mono tabular-nums leading-tight" style={{ color: meta.color }}>
                {fmtUSDT(wallet.totalEquityUSDT)}
              </span>
            </div>
            <TrendingUp className="h-5 w-5 mt-1 flex-shrink-0" style={{ color: meta.color, opacity: 0.5 }} />
          </div>

          {/* Available USDT */}
          <div
            className="flex items-center justify-between px-3 py-2 rounded-lg gap-2"
            style={{ background: "var(--app-success-tint)", border: "1px solid var(--app-success-border)" }}
          >
            <div className="flex items-center gap-1.5">
              <CircleDollarSign className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--app-success)" }} />
              <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--app-success)" }}>
                Available USDT
              </span>
            </div>
            <span className="text-sm font-extrabold font-mono tabular-nums" style={{ color: "var(--app-success)" }}>
              {fmtUSDT(wallet.availableUSDT)}
            </span>
          </div>

          {/* Asset count */}
          {wallet.assets.length > 0 && (
            <span className="text-[9px]" style={{ color: "var(--app-text-dim)" }}>
              {wallet.assets.length} asset{wallet.assets.length !== 1 ? "s" : ""} held
            </span>
          )}
        </div>
      ) : wallet?.status === "no_key" ? (
        <div className="px-4 py-6 flex flex-col items-center gap-2 text-center">
          <KeyRound className="h-8 w-8" style={{ color: "var(--app-text-dim)" }} />
          <span className="text-xs font-semibold" style={{ color: "var(--app-text-muted)" }}>
            API key not configured
          </span>
          <span className="text-[10px]" style={{ color: "var(--app-text-dim)" }}>
            Set {exchange.toUpperCase()}_API_KEY &amp; _SECRET in environment
          </span>
        </div>
      ) : (
        <div className="px-4 py-5 flex flex-col items-center gap-2 text-center">
          <XCircle className="h-7 w-7" style={{ color: "var(--app-danger)" }} />
          <span className="text-xs font-semibold" style={{ color: "var(--app-danger)" }}>
            Fetch failed
          </span>
          <span
            className="text-[10px] font-mono px-2 py-1 rounded"
            style={{ color: "var(--app-text-dim)", background: "var(--app-surface-2)", wordBreak: "break-all" }}
          >
            {wallet?.error ?? "Unknown error"}
          </span>
        </div>
      )}

      {/* ── Asset list ── */}
      {showAssets && (
        <>
          <div style={{ borderTop: "1px solid var(--app-border-0)" }}>
            <div
              className="px-3 py-1.5 flex items-center justify-between"
              style={{ background: "var(--app-surface-1)" }}
            >
              <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>
                Holdings
              </span>
              <span className="text-[9px] font-mono" style={{ color: "var(--app-text-dim)" }}>
                Free · Value
              </span>
            </div>
            {topAssets.map((a) => (
              <AssetRow key={a.coin} asset={a} />
            ))}
          </div>

          {hiddenCount > 0 && (
            <button
              onClick={() => setExpanded((x) => !x)}
              className="w-full flex items-center justify-center gap-1.5 py-2 text-[10px] font-semibold"
              style={{
                background:  "var(--app-surface-1)",
                borderTop:   "1px solid var(--app-border-0)",
                color:       "var(--app-text-muted)",
                cursor:      "pointer",
              }}
            >
              {expanded ? (
                <><ChevronUp className="h-3 w-3" /> Show less</>
              ) : (
                <><ChevronDown className="h-3 w-3" /> +{hiddenCount} more assets</>
              )}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Grand total bar ────────────────────────────────────────────────────────

function GrandTotalBar({ wallets, isLoading }) {
  const connectedWallets = wallets?.filter((w) => w.status === "ok") ?? [];
  const grandTotal       = connectedWallets.reduce((s, w) => s + (w.totalEquityUSDT ?? 0), 0);
  const grandAvailable   = connectedWallets.reduce((s, w) => s + (w.availableUSDT   ?? 0), 0);
  const connectedCount   = connectedWallets.length;
  const totalExchanges   = ALL_EXCHANGES.length;

  return (
    <div
      className="rounded-2xl px-5 py-4 flex flex-wrap items-center justify-between gap-4"
      style={{
        background:  "var(--app-surface-1)",
        border:      "1px solid var(--app-border-0)",
        marginBottom: 20,
      }}
    >
      {/* Left: portfolio total */}
      <div className="flex flex-col gap-0.5">
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>
          Total Portfolio
        </span>
        {isLoading ? (
          <Skeleton h={36} w={160} />
        ) : (
          <span className="text-3xl font-extrabold font-mono tabular-nums" style={{ color: "var(--app-text-bright)" }}>
            {fmtUSDT(grandTotal)}
          </span>
        )}
        <span className="text-[10px]" style={{ color: "var(--app-text-dim)" }}>
          {connectedCount} of {totalExchanges} exchanges connected
        </span>
      </div>

      {/* Right: available USDT */}
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dim)" }}>
          Available for Trading
        </span>
        {isLoading ? (
          <Skeleton h={28} w={120} />
        ) : (
          <span className="text-2xl font-extrabold font-mono tabular-nums" style={{ color: "var(--app-success)" }}>
            {fmtUSDT(grandAvailable)}
          </span>
        )}
        <span className="text-[10px]" style={{ color: "var(--app-text-dim)" }}>USDT across all exchanges</span>
      </div>
    </div>
  );
}

// ── API Key info banner ────────────────────────────────────────────────────

function KeyInfoBanner() {
  return (
    <div
      className="flex items-start gap-3 px-4 py-3 rounded-xl mb-5 text-[11px]"
      style={{
        background: "rgba(99,102,241,0.08)",
        border:     "1px solid rgba(99,102,241,0.25)",
        color:      "var(--app-text-muted)",
      }}
    >
      <KeyRound className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: "#818CF8" }} />
      <div className="flex flex-col gap-0.5">
        <span className="font-bold" style={{ color: "#818CF8" }}>API Key Configuration</span>
        <span>
          Keys are securely configured in environment variables. Set{" "}
          <code className="px-1 rounded text-[10px]" style={{ background: "var(--app-surface-2)" }}>
            EXCHANGE_API_KEY
          </code>{" "}
          and{" "}
          <code className="px-1 rounded text-[10px]" style={{ background: "var(--app-surface-2)" }}>
            EXCHANGE_API_SECRET
          </code>{" "}
          (KuCoin/Bitget also need{" "}
          <code className="px-1 rounded text-[10px]" style={{ background: "var(--app-surface-2)" }}>
            _PASSPHRASE
          </code>
          ) in the Secrets panel. Read-only permissions recommended.
        </span>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function WalletTab() {
  // Tick every second so "X s ago" labels update live without a full data refetch
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  // Track MANUAL refresh separately so the button doesn't flash on every 3s background poll
  const [isManualRefetching, setIsManualRefetching] = useState(false);

  const {
    data: wallets,
    isLoading,
    isFetching,
    refetch,
    dataUpdatedAt,
  } = useGetWalletBalances({
    query: {
      refetchInterval: 700,
      refetchIntervalInBackground: true,
      staleTime: 600,
      retry: 1,
    },
  });

  // Clear manual flag as soon as the fetch (any kind) settles
  useEffect(() => {
    if (!isFetching) setIsManualRefetching(false);
  }, [isFetching]);

  function handleManualRefresh() {
    setIsManualRefetching(true);
    refetch();
  }

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt) : null;

  // Build exchange cards in the fixed order
  const cards = ALL_EXCHANGES.map((ex) => {
    const wallet = wallets?.find((w) => w.exchange === ex) ?? { exchange: ex, status: "no_key", keyConfigured: false, totalEquityUSDT: 0, availableUSDT: 0, assets: [], error: null, fetchedAt: Date.now() };
    return { exchange: ex, wallet };
  });

  return (
    <div className="flex flex-col gap-0 max-w-6xl mx-auto">
      {/* ── Page header ── */}
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-xl"
            style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)" }}
          >
            <Wallet className="h-[18px] w-[18px]" style={{ color: "var(--app-text-muted)" }} />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-extrabold tracking-tight" style={{ color: "var(--app-text-bright)" }}>
              Wallet Overview
            </span>
            <div className="flex items-center gap-1.5">
              {/* Subtle live dot — shows data is auto-refreshing silently */}
              {!isLoading && (
                <span
                  className="animate-pulse inline-block rounded-full flex-shrink-0"
                  style={{ width: 5, height: 5, background: "var(--app-success)", opacity: 0.7 }}
                />
              )}
              <span className="text-[10px]" style={{ color: "var(--app-text-dim)" }}>
                {lastUpdated
                  ? `Updated ${lastUpdated.toLocaleTimeString()}`
                  : "Fetching balances…"}
              </span>
            </div>
          </div>
        </div>

        {/* Button only reacts to MANUAL refresh — not the silent background poll */}
        <button
          onClick={handleManualRefresh}
          disabled={isManualRefetching}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-opacity"
          style={{
            background:  "var(--app-surface-2)",
            border:      "1px solid var(--app-border-1)",
            color:       "var(--app-text-muted)",
            cursor:      isManualRefetching ? "not-allowed" : "pointer",
            opacity:     isManualRefetching ? 0.6 : 1,
          }}
        >
          <RefreshCw className={`h-3 w-3 ${isManualRefetching ? "animate-spin" : ""}`} />
          {isManualRefetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* ── Grand total ── */}
      <GrandTotalBar wallets={wallets} isLoading={isLoading} />

      {/* ── API key info ── */}
      <KeyInfoBanner />

      {/* ── Exchange cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map(({ exchange, wallet }) => (
          <ExchangeCard key={exchange} wallet={wallet} isLoading={isLoading} />
        ))}
      </div>
    </div>
  );
}
