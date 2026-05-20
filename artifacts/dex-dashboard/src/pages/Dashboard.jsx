import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useGetSpotOpportunities,
  useGetSpotStatus,
  getGetSpotOpportunitiesQueryKey,
  getGetSpotStatusQueryKey,
} from "@workspace/api-client-react";

import { ScannerTab } from "@/components/ScannerTab";
import { MarketsTab } from "@/components/MarketsTab";
import { SpotArbTab } from "@/components/SpotArbTab";
import { SpotMarketsTab } from "@/components/SpotMarketsTab";
import { WDTab }        from "@/components/WDTab";
import { WalletTab }    from "@/components/WalletTab";
import { TelegramTab }  from "@/components/TelegramTab";
import { TradesTab }    from "@/components/TradesTab";
import { SpotHedgeTab }          from "@/components/SpotHedgeTab";
import { SpotHedgeScannerTab }  from "@/components/SpotHedgeScannerTab";
import { SpotHedgePotentialTab } from "@/components/SpotHedgePotentialTab";
import { ScanParameters } from "@/components/ScanParameters";
import { useFundingArbWS } from "@/hooks/useFundingArbWS";
import { Zap, Sun, Moon, BarChart2, ScanSearch, ArrowLeftRight, Wallet, PiggyBank, Settings, Settings2, KeyRound, BellRing, ListOrdered, Scale, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { SettingsModal } from "@/components/SettingsModal";
import { SetDefaultsModal } from "@/components/SettingsTab";
import { loadSpotDefaults } from "@/lib/spotDefaults";

function useTheme() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("theme") || "dark",
  );
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-transitioning", "");
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    localStorage.setItem("theme", theme);
    const t = setTimeout(() => root.removeAttribute("data-transitioning"), 420);
    return () => clearTimeout(t);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

const DEFAULT_FILTERS = {
  maxSpread: 5,
  minNetProfit: -1,
  exchanges: { pi42: true, aster: true, delta: true, coinswitch: true },
};

function applyFilters(opportunities, filters) {
  const { maxSpread = 5, minNetProfit = -1, exchanges = {} } = filters;
  return opportunities.filter((o) => {
    if (exchanges[o.longExchange] === false) return false;
    if (exchanges[o.shortExchange] === false) return false;
    if (Math.abs(o.spreadPct ?? 0) * 100 > maxSpread) return false;
    if ((o.netProfit ?? 0) * 100 < minNetProfit) return false;
    return true;
  });
}

// ── Inline error banner ────────────────────────────────────────────────────
function ApiErrorBanner({ message, detail }) {
  if (!message) return null;
  return (
    <div
      style={{
        background: "var(--app-danger-soft)",
        border: "1px solid var(--app-danger)",
        borderRadius: 8,
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 12,
        color: "var(--app-danger)",
        margin: "8px 12px 0",
      }}
    >
      <span style={{ fontWeight: 700 }}>⚠ {message}</span>
      {detail && (
        <span style={{ color: "var(--app-text-muted)", fontWeight: 400 }}>— {detail}</span>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [topPage, setTopPage]         = useState("funding");
  const [activeTab, setActiveTab]     = useState("scanner");
  const [spotSubTab, setSpotSubTab]   = useState("scanner");
  const [hedgeSubTab, setHedgeSubTab] = useState("scanner");
  const [theme, toggleTheme] = useTheme();
  const [settingsDropdownOpen, setSettingsDropdownOpen] = useState(false);
  const [settingsPanelOpen,    setSettingsPanelOpen]    = useState(null); // "api" | "defaults"
  const settingsRef = useRef(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [targetedSpread, setTargetedSpread]           = useState(0.02);
  const [spotDefaults, setSpotDefaults]               = useState(loadSpotDefaults);
  const [targetedNetProfit, setTargetedNetProfit]     = useState(() => loadSpotDefaults().targetedNetProfit);
  const prevFundingStatusRef = useRef({});
  const prevSpotStatusRef    = useRef({});
  const apiErrorToastRef     = useRef(null);
  const spotErrorToastRef    = useRef(null);
  const spotErrorTimerRef      = useRef(null);
  const scannerErrorTimerRef   = useRef(null);
  const [scannerErrorReady, setScannerErrorReady] = useState(false);
  const [spotErrorReady, setSpotErrorReady] = useState(false);

  // ── Close settings dropdown on outside click ───────────────────────────────
  useEffect(() => {
    if (!settingsDropdownOpen) return;
    const handler = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setSettingsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsDropdownOpen]);

  // ── Wallet / portfolio summary for header ─────────────────────────────────
  const { data: wallets = [] } = useQuery({
    queryKey: ["wallet-balances-header"],
    queryFn: async () => {
      const r = await fetch("/api/wallet/balances");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 1_000,
    refetchIntervalInBackground: false,
    staleTime: 800,
    retry: 1,
  });
  const okWallets     = wallets.filter((w) => w.status === "ok");
  const portfolioTotal = okWallets.reduce((s, w) => s + (w.totalEquityUSDT ?? 0), 0);
  const availTotal     = okWallets.reduce((s, w) => s + (w.availableUSDT   ?? 0), 0);
  const hasWallet      = okWallets.length > 0;

  // ── Funding Arb — WS primary (500 ms push), REST fallback ───────────────
  const { data: wsArbData, connected: wsConnected } = useFundingArbWS();

  // REST fallback — only fires when WS is not yet connected or has no data yet
  const { data: httpOpportunities = [], isError: scannerOppIsError } = useQuery({
    queryKey: ["scanner-opportunities"],
    queryFn: async () => {
      const r = await fetch("/api/scanner/opportunities");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    // WS is primary — only poll REST when WS is not connected or has no data yet
    refetchInterval: wsConnected && wsArbData ? false : 1_000,
    refetchIntervalInBackground: false,
    staleTime: 600,
    gcTime: 30_000,
    retry: 1,
    retryDelay: 1_000,
  });

  const { data: httpScannerStatus = null, isError: scannerStatusIsError } = useQuery({
    queryKey: ["scanner-status"],
    queryFn: async () => {
      const r = await fetch("/api/scanner/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    // WS is primary — only poll REST when WS is not connected or has no data yet
    refetchInterval: wsConnected && wsArbData ? false : 1_000,
    refetchIntervalInBackground: false,
    staleTime: 600,
    gcTime: 30_000,
    retry: 1,
    retryDelay: 1_000,
  });

  // WS is primary — use WS data when available, fall back to REST
  const opportunities  = wsArbData?.opportunities ?? httpOpportunities;
  const scannerStatus  = wsArbData?.status        ?? httpScannerStatus;

  // Slow-changing data fetched via REST (not included in WS to keep payload small)
  const { data: marketsData = null } = useQuery({
    queryKey:        ["scanner-markets"],
    queryFn:         async () => {
      const r = await fetch("/api/markets");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval:          30_000,
    refetchIntervalInBackground: false,
    staleTime:                25_000,
    gcTime:                   120_000,
    retry: 1,
  });

  const { data: priceMovements = null } = useQuery({
    queryKey:        ["scanner-price-movements"],
    queryFn:         async () => {
      const r = await fetch("/api/scanner/price-movements");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval:          60_000,
    refetchIntervalInBackground: false,
    staleTime:                55_000,
    gcTime:                   120_000,
    retry: 1,
  });
  // Delay the error state by 5 s to avoid a false-positive toast on initial load.
  useEffect(() => {
    const hasError = scannerOppIsError || scannerStatusIsError;
    if (!hasError) {
      setScannerErrorReady(false);
      if (scannerErrorTimerRef.current) {
        clearTimeout(scannerErrorTimerRef.current);
        scannerErrorTimerRef.current = null;
      }
      return;
    }
    if (!scannerErrorTimerRef.current) {
      scannerErrorTimerRef.current = setTimeout(() => {
        setScannerErrorReady(true);
        scannerErrorTimerRef.current = null;
      }, 5_000);
    }
    return () => {
      if (scannerErrorTimerRef.current) {
        clearTimeout(scannerErrorTimerRef.current);
        scannerErrorTimerRef.current = null;
      }
    };
  }, [scannerOppIsError, scannerStatusIsError]);

  const statusIsError = scannerErrorReady && (scannerOppIsError || scannerStatusIsError);

  // ── Spot Arb data ─────────────────────────────────────────────────────────
  const { data: spotOpportunities = [], isError: spotOppIsError } = useGetSpotOpportunities(
    { targetedNetProfit },
    {
      query: {
        refetchInterval: 1_000,
        refetchIntervalInBackground: false,
        staleTime: 800,
        gcTime: 30_000,
        queryKey: getGetSpotOpportunitiesQueryKey({ targetedNetProfit }),
        retry: 3,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
    },
  );

  const { data: spotStatus, isError: spotStatusIsError } = useGetSpotStatus({
    query: {
      refetchInterval: 1_000,
      refetchIntervalInBackground: false,
      staleTime: 800,
      gcTime: 30_000,
      queryKey: getGetSpotStatusQueryKey(),
      retry: 3,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
  });

  // ── Debounced spot error — only fire after 5 s of sustained failure ────────
  useEffect(() => {
    const hasError = spotOppIsError || spotStatusIsError;
    if (!hasError) {
      setSpotErrorReady(false);
      if (spotErrorTimerRef.current) {
        clearTimeout(spotErrorTimerRef.current);
        spotErrorTimerRef.current = null;
      }
      return;
    }
    if (!spotErrorTimerRef.current) {
      spotErrorTimerRef.current = setTimeout(() => {
        setSpotErrorReady(true);
        spotErrorTimerRef.current = null;
      }, 5_000);
    }
    return () => {
      if (spotErrorTimerRef.current) {
        clearTimeout(spotErrorTimerRef.current);
        spotErrorTimerRef.current = null;
      }
    };
  }, [spotOppIsError, spotStatusIsError]);

  // ── Toast: API server unreachable (funding arb) ───────────────────────────
  useEffect(() => {
    if (statusIsError) {
      if (!apiErrorToastRef.current) {
        apiErrorToastRef.current = toast.error("Cannot reach API server", {
          description: "Funding Arb scanner data unavailable. Check server is running.",
          duration: Infinity,
          onDismiss: () => { apiErrorToastRef.current = null; },
        });
      }
    } else {
      if (apiErrorToastRef.current) {
        toast.dismiss(apiErrorToastRef.current);
        apiErrorToastRef.current = null;
        toast.success("API server reconnected", { duration: 3000 });
      }
    }
  }, [statusIsError]);

  // ── Toast: Spot scanner API error (only after 5 s sustained failure) ────────
  useEffect(() => {
    if (spotErrorReady) {
      if (!spotErrorToastRef.current) {
        spotErrorToastRef.current = toast.error("Spot scanner error", {
          description: "Cannot fetch spot arbitrage data. Retrying…",
          duration: Infinity,
          onDismiss: () => { spotErrorToastRef.current = null; },
        });
      }
    } else {
      if (spotErrorToastRef.current) {
        toast.dismiss(spotErrorToastRef.current);
        spotErrorToastRef.current = null;
      }
    }
  }, [spotErrorReady]);

  // ── Toast: Funding Arb exchange status changes ────────────────────────────
  useEffect(() => {
    if (!scannerStatus?.exchanges) return;
    scannerStatus.exchanges.forEach((ex) => {
      const prev = prevFundingStatusRef.current[ex.exchange];
      const curr = ex.status;
      if (prev === undefined) {
        prevFundingStatusRef.current[ex.exchange] = curr;
        return;
      }
      if (prev === curr) return;
      prevFundingStatusRef.current[ex.exchange] = curr;
      const name = ex.exchange.toUpperCase();

      if (curr === "online") {
        toast.success(`${name} back online`, {
          description: `${ex.instrumentCount} instruments available`,
          duration: 4000,
        });
      } else if (curr === "degraded") {
        toast.warning(`${name} degraded`, {
          description: "Partial data — some instruments may be stale",
          duration: 5000,
        });
      } else {
        toast.error(`${name} went offline`, {
          description: "Retrying connection automatically",
          duration: 6000,
        });
      }
    });
  }, [scannerStatus]);

  // ── Toast: Spot exchange status changes ───────────────────────────────────
  useEffect(() => {
    if (!spotStatus?.exchanges) return;
    spotStatus.exchanges.forEach((ex) => {
      const prev = prevSpotStatusRef.current[ex.exchange];
      const curr = ex.status;
      if (prev === undefined) {
        prevSpotStatusRef.current[ex.exchange] = curr;
        return;
      }
      if (prev === curr) return;
      prevSpotStatusRef.current[ex.exchange] = curr;
      const name = ex.exchange.toUpperCase();

      if (curr === "online") {
        toast.success(`Spot ${name} back online`, {
          description: `${ex.symbolCount ?? "?"} symbols`,
          duration: 4000,
        });
      } else {
        toast.error(`Spot ${name} went offline`, {
          description: "Retrying connection automatically",
          duration: 6000,
        });
      }
    });
  }, [spotStatus]);

  const filteredCount = useMemo(
    () => applyFilters(opportunities, filters).length,
    [opportunities, filters],
  );

  const topPages = [
    { id: "funding", label: "Funding Arb", icon: Zap            },
    { id: "spot",    label: "Spot Arb",    icon: ArrowLeftRight },
    { id: "hedge",   label: "Spot Hedge",  icon: Scale          },
  ];

  const fundingSubTabs = [
    { id: "scanner", label: "Scanner", icon: ScanSearch },
    { id: "markets", label: "Markets", icon: BarChart2  },
  ];

  const spotSubTabs = [
    { id: "scanner",  label: "Scanner",  icon: ScanSearch  },
    { id: "markets",  label: "Markets",  icon: BarChart2   },
    { id: "trades",   label: "Trades",   icon: ListOrdered },
    { id: "wd",       label: "W-D",      icon: Wallet      },
    { id: "wallet",   label: "Wallet",   icon: PiggyBank   },
    { id: "telegram", label: "Alerts",   icon: BellRing    },
  ];

  const hedgeSubTabs = [
    { id: "scanner",   label: "Scanner",   icon: ScanSearch  },
    { id: "markets",   label: "Markets",   icon: BarChart2   },
    { id: "potential", label: "Potential", icon: TrendingUp  },
    { id: "trades",    label: "Trades",    icon: ListOrdered },
    { id: "wallet",    label: "Wallet",    icon: PiggyBank   },
    { id: "alerts",    label: "Alerts",    icon: BellRing    },
  ];

  const handleDefaultsChange = useCallback((newDefaults) => {
    setSpotDefaults(newDefaults);
    setTargetedNetProfit(newDefaults.targetedNetProfit);
  }, []);

  return (
    <div
      className="h-screen overflow-hidden flex flex-col"
      style={{ background: "var(--app-bg)", color: "var(--app-text-primary)" }}
    >
      {/* ── Top header bar ── */}
      <header
        className="sticky top-0 z-20 flex items-center justify-between px-3 sm:px-6 py-3"
        style={{ background: "var(--app-header-bg)", borderBottom: "1px solid var(--app-header-border)" }}
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div
            className="flex-shrink-0 flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg"
            style={{ background: "var(--app-logo-bg)", border: "1px solid var(--app-success)" }}
          >
            <Zap className="h-4 w-4 sm:h-5 sm:w-5" style={{ color: "var(--app-success)" }} />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm sm:text-base font-extrabold tracking-tight leading-tight truncate" style={{ color: "var(--app-text-bright)" }}>
              MONEY MACHINE
            </span>
            <span
              className="hidden sm:block text-[10px] font-semibold uppercase tracking-widest leading-tight"
              style={{ color: "var(--app-text-muted)" }}
            >
              Live Terminal&nbsp;//&nbsp;Cross-Exchange Scanner
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          {/* ── Settings dropdown — hidden on Spot Hedge tab ── */}
          {topPage !== "hedge" && <div className="relative" ref={settingsRef}>
            <button
              onClick={() => setSettingsDropdownOpen((v) => !v)}
              className="flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-full"
              style={{
                background: settingsDropdownOpen ? "var(--app-success-soft)" : "var(--app-surface-2)",
                border: `1px solid ${settingsDropdownOpen ? "var(--app-success-border)" : "var(--app-border-1)"}`,
                transition: "all 0.15s",
              }}
              title="Settings"
            >
              <Settings className="h-4 w-4" style={{ color: settingsDropdownOpen ? "var(--app-success)" : "var(--app-text-muted)" }} />
            </button>

            {settingsDropdownOpen && (
              <div
                className="absolute right-0 top-full mt-2 z-50 flex flex-col overflow-hidden"
                style={{
                  minWidth: 186,
                  background: "var(--app-surface-1)",
                  border: "1px solid var(--app-border-1)",
                  borderRadius: 10,
                  boxShadow: "0 8px 32px rgba(0,0,0,0.38)",
                }}
              >
                <button
                  onClick={() => { setSettingsDropdownOpen(false); setSettingsPanelOpen("api"); }}
                  className="flex items-center gap-2.5 px-4 py-3 w-full text-left text-xs font-semibold transition-colors"
                  style={{ color: "var(--app-text-muted)", background: "transparent" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--app-surface-2)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <KeyRound className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--app-warning)" }} />
                  API Management
                </button>
                {topPage === "spot" && (
                  <>
                    <div style={{ height: 1, background: "var(--app-border-0)" }} />
                    <button
                      onClick={() => { setSettingsDropdownOpen(false); setSettingsPanelOpen("defaults"); }}
                      className="flex items-center gap-2.5 px-4 py-3 w-full text-left text-xs font-semibold transition-colors"
                      style={{ color: "var(--app-text-muted)", background: "transparent" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--app-surface-2)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <Settings2 className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--app-success)" }} />
                      Set Defaults
                    </button>
                  </>
                )}
              </div>
            )}
          </div>}
          <button
            onClick={toggleTheme}
            className="flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-full"
            style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)" }}
            data-testid="button-theme-toggle"
          >
            <span key={theme} className="theme-icon-animate">
              {theme === "dark" ? (
                <Sun className="h-4 w-4" style={{ color: "var(--app-text-muted)" }} />
              ) : (
                <Moon className="h-4 w-4" style={{ color: "var(--app-text-muted)" }} />
              )}
            </span>
          </button>

          <div
            className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md"
            style={{ border: "1px solid var(--app-danger)", background: "var(--app-danger-soft)" }}
          >
            <span className="relative flex h-2 w-2">
              <span
                className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                style={{ background: "var(--app-danger)" }}
              />
              <span
                className="relative inline-flex rounded-full h-2 w-2"
                style={{ background: "var(--app-danger)" }}
              />
            </span>
            <span
              className="text-xs font-bold tracking-widest uppercase"
              style={{ color: "var(--app-danger)" }}
            >
              Live
            </span>
          </div>
        </div>
      </header>

      {/* ── Navigation tabs ── */}
      <nav
        style={{ background: "var(--app-header-bg)", borderBottom: "1px solid var(--app-header-border)" }}
        className="px-3 sm:px-6"
      >
        <div className="flex items-center gap-3 py-2">
          <div
            className="inline-flex items-center rounded-lg p-1"
            style={{
              background: "var(--app-surface-1)",
              border:     "1px solid var(--app-border-0)",
            }}
          >
            {topPages.map(({ id, label, icon: Icon }) => {
              const active = topPage === id;
              return (
                <button
                  key={id}
                  onClick={() => setTopPage(id)}
                  data-testid={`page-${id}`}
                  className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-md transition-all"
                  style={{
                    background: active ? "var(--app-success-soft)"   : "transparent",
                    color:      active ? "var(--app-success)"        : "var(--app-text-dim)",
                    border:     active ? "1px solid var(--app-success-border)" : "1px solid transparent",
                    boxShadow:  active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = "var(--app-text-muted)"; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = "var(--app-text-dim)"; }}
                >
                  <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  {label}
                </button>
              );
            })}
          </div>

          {/* Portfolio + Available Balance — desktop (only on Spot Arb) */}
          <div className={`ml-auto hidden md:flex items-center gap-4 ${topPage !== "spot" ? "invisible pointer-events-none" : ""}`}>
            {hasWallet ? (
              <>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                    Portfolio
                  </span>
                  <span className="text-[13px] font-extrabold font-mono leading-none" style={{ color: "var(--app-text-primary)" }}>
                    ${portfolioTotal >= 1_000 ? (portfolioTotal / 1_000).toFixed(2) + "K" : portfolioTotal.toFixed(2)}
                  </span>
                </div>
                <div style={{ width: 1, height: 28, background: "var(--app-border-1)", flexShrink: 0 }} />
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                    Available For Trading
                  </span>
                  <span className="text-[13px] font-extrabold font-mono leading-none" style={{ color: "var(--app-success)" }}>
                    ${availTotal >= 1_000 ? (availTotal / 1_000).toFixed(2) + "K" : availTotal.toFixed(2)}
                  </span>
                </div>
              </>
            ) : (
              <span className="text-[10px]" style={{ color: "var(--app-text-dimmer)" }}>
                No wallet keys configured
              </span>
            )}
          </div>
        </div>
      </nav>

      {/* ── Portfolio strip — mobile only, shown only on Spot Arb ── */}
      <div
        className={`flex md:hidden items-center justify-between px-4 py-2 ${topPage !== "spot" ? "hidden" : ""}`}
        style={{ background: "var(--app-header-bg)", borderBottom: "1px solid var(--app-header-border)" }}
      >
        <div className="flex flex-col gap-0">
          <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
            Portfolio
          </span>
          <span className="text-xs font-extrabold font-mono" style={{ color: "var(--app-text-primary)" }}>
            {hasWallet
              ? `$${portfolioTotal >= 1_000 ? (portfolioTotal / 1_000).toFixed(2) + "K" : portfolioTotal.toFixed(2)}`
              : "—"}
          </span>
        </div>
        <div style={{ width: 1, height: 24, background: "var(--app-border-1)" }} />
        <div className="flex flex-col gap-0 items-end">
          <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
            Available For Trading
          </span>
          <span className="text-xs font-extrabold font-mono" style={{ color: "var(--app-success)" }}>
            {hasWallet
              ? `$${availTotal >= 1_000 ? (availTotal / 1_000).toFixed(2) + "K" : availTotal.toFixed(2)}`
              : "—"}
          </span>
        </div>
      </div>

      {/* ── Sub-tabs ── */}
      {(topPage === "funding" || topPage === "spot" || topPage === "hedge") && (
        <nav
          style={{ background: "var(--app-bg)", borderBottom: "1px solid var(--app-border-0)" }}
          className="px-3 sm:px-6"
        >
          <div className="flex items-center gap-0 overflow-x-auto no-scrollbar">
            {(topPage === "funding" ? fundingSubTabs : topPage === "spot" ? spotSubTabs : hedgeSubTabs).map(({ id, label, icon: Icon }) => {
              const currentSub = topPage === "funding" ? activeTab : topPage === "spot" ? spotSubTab : hedgeSubTab;
              const setCurrentSub = topPage === "funding" ? setActiveTab : topPage === "spot" ? setSpotSubTab : setHedgeSubTab;
              const active = currentSub === id;
              return (
                <button
                  key={id}
                  onClick={() => setCurrentSub(id)}
                  data-testid={`tab-${id}`}
                  className="flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-[11px] sm:text-xs font-bold uppercase tracking-widest relative transition-colors whitespace-nowrap flex-shrink-0"
                  style={{ color: active ? "var(--app-success)" : "var(--app-text-dim)" }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = "var(--app-text-muted)"; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = "var(--app-text-dim)"; }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                  {active && (
                    <span
                      className="absolute -bottom-px left-2 right-2 h-[2px] rounded-t"
                      style={{ background: "var(--app-success)" }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </nav>
      )}

      {/* ── Inline API error banner (visible even when toasts are dismissed) ── */}
      {statusIsError && topPage === "funding" && (
        <ApiErrorBanner
          message="API server unreachable"
          detail="Funding Arb data unavailable — check server is running"
        />
      )}
      {spotErrorReady && topPage === "spot" && (
        <ApiErrorBanner
          message="Spot scanner error"
          detail="Cannot fetch spot arbitrage data — retrying…"
        />
      )}

      {/* ── Main content ── */}
      <main
        className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 sm:py-5"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom, 0px))" }}
      >
        {topPage === "funding" && activeTab === "scanner" && (
          <>
            <ScanParameters
              filters={filters}
              onApply={setFilters}
              opportunityCount={filteredCount}
              scannerStatus={scannerStatus}
            />
            <ScannerTab
              opportunities={opportunities}
              filters={filters}
              targetedSpread={targetedSpread}
              onTargetedSpreadChange={setTargetedSpread}
              priceMovements={priceMovements}
            />
          </>
        )}
        {topPage === "funding" && activeTab === "markets" && (
          <MarketsTab marketsData={marketsData} scannerStatus={scannerStatus} />
        )}
        {topPage === "spot" && spotSubTab === "scanner" && (
          <SpotArbTab
            spotOpportunities={spotOpportunities}
            spotStatus={spotStatus}
            targetedNetProfit={targetedNetProfit}
            onTargetedNetProfitChange={setTargetedNetProfit}
            initialTradeAmount={spotDefaults.tradeAmount}
            initialMinTimesHit={spotDefaults.minTimesHit}
          />
        )}
        {topPage === "spot" && spotSubTab === "markets" && (
          <SpotMarketsTab spotStatus={spotStatus} />
        )}
        {topPage === "spot" && spotSubTab === "trades" && (
          <TradesTab />
        )}
        {topPage === "spot" && spotSubTab === "wd" && (
          <WDTab />
        )}
        {topPage === "spot" && spotSubTab === "wallet" && (
          <WalletTab />
        )}
        {topPage === "spot" && spotSubTab === "telegram" && (
          <TelegramTab />
        )}

        {/* ── Spot Hedge pages ── */}
        {topPage === "hedge" && hedgeSubTab === "scanner" && (
          <SpotHedgeScannerTab
            spotOpportunities={spotOpportunities}
            spotStatus={spotStatus}
            targetedNetProfit={targetedNetProfit}
            onTargetedNetProfitChange={setTargetedNetProfit}
          />
        )}
        {topPage === "hedge" && hedgeSubTab === "markets" && (
          <SpotMarketsTab spotStatus={spotStatus} />
        )}
        {topPage === "hedge" && hedgeSubTab === "wallet" && (
          <WalletTab />
        )}
        {topPage === "hedge" && hedgeSubTab === "potential" && (
          <SpotHedgePotentialTab spotOpportunities={spotOpportunities} />
        )}
        {topPage === "hedge" && (hedgeSubTab === "trades" || hedgeSubTab === "alerts") && (
          <SpotHedgeTab activeSubTab={hedgeSubTab} />
        )}
      </main>

      {settingsPanelOpen === "api" && (
        <SettingsModal onClose={() => setSettingsPanelOpen(null)} topPage={topPage} />
      )}
      {settingsPanelOpen === "defaults" && (
        <SetDefaultsModal onClose={() => setSettingsPanelOpen(null)} onSave={handleDefaultsChange} />
      )}
    </div>
  );
}
