import { useState, useEffect, useMemo, memo } from "react";
import { ArrowLeftRight, Clock, BarChart2 } from "lucide-react";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { CoinIcon } from "@/components/CoinIcon";

const fmt4 = (v) => (v * 100).toFixed(4) + "%";
const fmtPrice = (v) =>
  v != null
    ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
    : "—";

function CountdownHMS({ targetEpochMs }) {
  const [parts, setParts] = useState({ h: "00", m: "00", s: "00" });
  useEffect(() => {
    if (!targetEpochMs) return;
    const tick = () => {
      const diff = Math.max(0, targetEpochMs - Date.now());
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1000);
      setParts({ h: String(h).padStart(2, "0"), m: String(m).padStart(2, "0"), s: String(s).padStart(2, "0") });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetEpochMs]);
  return (
    <span className="font-mono tabular-nums text-sm font-bold tracking-widest text-[var(--app-success)]">
      {parts.h}:{parts.m}:{parts.s}
    </span>
  );
}

const LONG_BADGE = (
  <span
    className="flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md tracking-widest uppercase"
    style={{ background: "var(--app-success-soft)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}
  >
    LONG
  </span>
);

const SHORT_BADGE = (
  <span
    className="flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md tracking-widest uppercase"
    style={{ background: "var(--app-danger-soft)", color: "var(--app-danger)", border: "1px solid var(--app-danger-border)" }}
  >
    SHORT
  </span>
);

function LevBadge({ lev }) {
  if (lev == null) return null;
  return (
    <span
      className="flex-shrink-0 text-[10px] font-bold font-mono px-1 py-0.5 rounded"
      style={{ background: "rgba(99,102,241,0.10)", color: "#818cf8", border: "1px solid rgba(99,102,241,0.2)" }}
    >
      {lev}×
    </span>
  );
}

export const ArbitrageCard = memo(function ArbitrageCard({ opp, movements, targetedSpread = 0.5 }) {
  const priceMovement = useMemo(() => {
    const labels = ["4H", "8H", "12H", "24H"];
    if (!movements) return labels.map((label) => ({ label, pct: null }));
    return labels.map((label) => ({ label, pct: movements[label] ?? null }));
  }, [movements]);

  const spreadPct  = opp.spreadPct  ?? 0;
  const totalFees  = opp.totalFees  ?? 0;
  const netProfit  = opp.netProfit  ?? 0;
  const timesHit   = opp.spreadTimesHit   ?? 0;
  const lowestSpread = opp.lowestSpreadPct ?? spreadPct;

  const longFundColor  = (opp.longFundingRate  ?? 0) >= 0 ? "var(--app-success)" : "var(--app-danger)";
  const shortFundColor = (opp.shortFundingRate ?? 0) >= 0 ? "var(--app-success)" : "var(--app-danger)";

  return (
    <div
      className="rounded-xl overflow-hidden flex flex-col"
      style={{ background: "var(--app-surface-0)", border: "1px solid var(--app-border-0)" }}
    >
      {/* ── Header: symbol + countdown ── */}
      <div
        className="flex items-center justify-between px-3 py-2.5 gap-2"
        style={{ background: "var(--app-surface-1)", borderBottom: "1px solid var(--app-border-0)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <CoinIcon symbol={opp.symbol} />
          <span
            className="text-base font-extrabold tracking-tight uppercase truncate"
            style={{ color: "var(--app-text-bright)" }}
          >
            {opp.symbol}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Clock className="h-3.5 w-3.5 text-[var(--app-success)]" />
          <CountdownHMS targetEpochMs={opp.nextFundingAt} />
        </div>
      </div>

      <div className="flex flex-col gap-0 p-3">
        {/* ── Exchange row ── */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center mb-2 gap-1">
          {/* Long side */}
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-1 flex-wrap">
              {LONG_BADGE}
              <span
                className="text-[10px] font-bold uppercase tracking-wide"
                style={{ color: "var(--app-text-bright)" }}
              >
                {opp.longExchange}
              </span>
            </div>
            {opp.longMaxLeverage != null && (
              <div className="pl-1">
                <LevBadge lev={opp.longMaxLeverage} />
              </div>
            )}
          </div>

          {/* Center arrow */}
          <ArrowLeftRight className="h-3 w-3 flex-shrink-0 mx-1" style={{ color: "var(--app-icon-arrow)" }} />

          {/* Short side */}
          <div className="flex flex-col gap-0.5 items-end min-w-0">
            <div className="flex items-center gap-1 flex-wrap justify-end">
              <span
                className="text-[10px] font-bold uppercase tracking-wide"
                style={{ color: "var(--app-text-bright)" }}
              >
                {opp.shortExchange}
              </span>
              {SHORT_BADGE}
            </div>
            {opp.shortMaxLeverage != null && (
              <div className="pr-1">
                <LevBadge lev={opp.shortMaxLeverage} />
              </div>
            )}
          </div>
        </div>

        {/* ── Price row ── */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-bold font-mono tabular-nums" style={{ color: "var(--app-text-bright)" }}>
              <AnimatedNumber value={opp.longAsk} format={fmtPrice} />
            </span>
            <span className="text-[11px] font-mono" style={{ color: longFundColor }}>
              Fund:{" "}
              <AnimatedNumber
                value={opp.longFundingRate}
                format={(v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(4) + "%"}
              />
            </span>
          </div>
          <div className="flex flex-col items-end min-w-0">
            <span className="text-sm font-bold font-mono tabular-nums" style={{ color: "var(--app-text-bright)" }}>
              <AnimatedNumber value={opp.shortBid} format={fmtPrice} />
            </span>
            <span className="text-[11px] font-mono" style={{ color: shortFundColor }}>
              Fund:{" "}
              <AnimatedNumber
                value={opp.shortFundingRate}
                format={(v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(4) + "%"}
              />
            </span>
          </div>
        </div>

        {/* ── Divider ── */}
        <div style={{ borderTop: "1px solid var(--app-border-0)" }} className="mb-2" />

        {/* ── Funding diff + Spread / Fees ── */}
        <div className="grid grid-cols-2 gap-3 mb-2">
          <div className="min-w-0">
            <div
              className="text-[10px] font-semibold uppercase tracking-widest mb-1 whitespace-nowrap"
              style={{ color: "var(--app-text-muted)" }}
            >
              Fund Diff <span style={{ color: "var(--app-text-dimmer)" }}>(8h)</span>
            </div>
            <AnimatedNumber
              value={opp.fundingRateDiff}
              format={fmt4}
              className="text-base font-bold"
              style={{ color: "var(--app-success)" }}
            />
          </div>
          <div className="min-w-0">
            <div
              className="text-[10px] font-semibold uppercase tracking-widest mb-1 whitespace-nowrap"
              style={{ color: "var(--app-text-muted)" }}
            >
              Spread / Fees
            </div>
            <span className="text-base font-bold font-mono" style={{ color: "var(--app-warning)" }}>
              {(spreadPct * 100).toFixed(3)}%
              <span className="text-xs ml-1" style={{ color: "var(--app-text-muted)" }}>
                / {(totalFees * 100).toFixed(3)}%
              </span>
            </span>
          </div>
        </div>

        {/* ── Divider ── */}
        <div style={{ borderTop: "1px solid var(--app-border-0)" }} className="mb-2" />

        {/* ── Price Movement ── */}
        <div className="mb-2">
          <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--app-text-muted)" }}>
            Price Movement
          </div>
          <div className="grid grid-cols-4 gap-1">
            {priceMovement.map(({ label, pct }) => (
              <div
                key={label}
                className="flex flex-col items-center rounded-lg py-1.5"
                style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)" }}
              >
                <span
                  className="text-[9px] font-bold uppercase tracking-wider mb-0.5"
                  style={{ color: "var(--app-text-dim)" }}
                >
                  {label}
                </span>
                <span
                  className="text-[10px] font-bold font-mono tabular-nums"
                  style={{ color: pct == null ? "var(--app-text-dimmer)" : pct >= 0 ? "var(--app-success)" : "var(--app-danger)" }}
                >
                  {pct == null ? "—" : (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Divider ── */}
        <div style={{ borderTop: "1px solid var(--app-border-0)" }} className="mb-2" />

        {/* ── Spread Hits ── */}
        <div className="mb-2">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <BarChart2 className="h-3 w-3" style={{ color: "var(--app-text-dim)" }} />
              <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                Spread Hits
              </span>
            </div>
            {timesHit > 0 ? (
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-full tracking-wider flex-shrink-0"
                style={{ background: "var(--app-success-tint)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}
              >
                ● IN RANGE
              </span>
            ) : (
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-full tracking-wider flex-shrink-0"
                style={{ background: "var(--app-surface-2)", color: "var(--app-text-dimmer)", border: "1px solid var(--app-border-1)" }}
              >
                ○ NOT YET
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <div className="flex flex-col">
              <span className="text-base font-bold tabular-nums" style={{ color: "var(--app-success)" }}>
                {timesHit}
              </span>
              <span className="text-[9px] uppercase tracking-wide font-medium" style={{ color: "var(--app-text-dim)" }}>
                Times Hit
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-base font-bold font-mono" style={{ color: "var(--app-warning)" }}>
                {(lowestSpread * 100).toFixed(3)}%
              </span>
              <span className="text-[9px] uppercase tracking-wide font-medium" style={{ color: "var(--app-text-dim)" }}>
                Low Spread
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-base font-bold font-mono" style={{ color: "var(--app-text-muted)" }}>
                {targetedSpread.toFixed(2)}%
              </span>
              <span className="text-[9px] uppercase tracking-wide font-medium" style={{ color: "var(--app-text-dim)" }}>
                Target
              </span>
            </div>
          </div>
        </div>

        {/* ── Divider ── */}
        <div style={{ borderTop: "1px solid var(--app-border-0)" }} className="mb-2" />

        {/* ── Est. Net Profit ── */}
        <div
          className="flex flex-col items-center py-2.5 rounded-lg"
          style={{
            background: netProfit >= 0 ? "var(--app-success-tint)" : "var(--app-danger-tint)",
            border: `1px solid ${netProfit >= 0 ? "var(--app-success-border)" : "var(--app-danger-border)"}`,
          }}
        >
          <span className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: "var(--app-text-muted)" }}>
            Est. Net Profit
          </span>
          <AnimatedNumber
            value={netProfit}
            format={(v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(4) + "%"}
            className="text-xl font-extrabold"
            style={{ color: netProfit >= 0 ? "var(--app-success)" : "var(--app-danger)" }}
          />
          <span
            className="text-[9px] mt-1.5 font-mono text-center px-2 leading-relaxed"
            style={{ color: "var(--app-text-dim)", wordBreak: "break-all" }}
          >
            {fmt4(opp.fundingRateDiff)} − {(spreadPct * 100).toFixed(3)}% − {(totalFees * 100).toFixed(3)}%
          </span>
        </div>
      </div>
    </div>
  );
});
