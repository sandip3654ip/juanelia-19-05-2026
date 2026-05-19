import { memo, useMemo, useState } from "react";
import { CoinIcon }     from "@/components/CoinIcon";
import { ExchangeIcon } from "@/components/ExchangeIcon";
import { computeProjectedProfit } from "@/lib/projectedProfit";

// ── Number formatters ──────────────────────────────────────────────────────

function fmtPrice(v) {
  if (v == null) return "—";
  if (v >= 1_000) return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1)     return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function fmtPct(v, showSign = true) {
  if (v == null) return "—";
  const sign = showSign && v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(3)}%`;
}

function fmtFeePct(r) {
  return `${(r * 100).toFixed(2)}%`;
}

/** Raw coin fee exactly as the exchange charges it. */
function fmtCoinFee(fee, sym) {
  if (fee == null || fee === 0) return null;
  if (fee >= 1_000_000) return `${fee.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${sym}`;
  if (fee >= 1)         return `${fee.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${sym}`;
  if (fee >= 0.001)     return `${fee.toFixed(6)} ${sym}`;
  return `${fee.toExponential(2)} ${sym}`;
}

function fmtUSDT(usd) {
  if (usd == null)  return null;
  if (usd === 0)    return "0 USDT";
  if (usd < 0.0001) return `${usd.toExponential(2)} USDT`;
  if (usd < 0.01)   return `${usd.toFixed(4)} USDT`;
  if (usd < 1)      return `${usd.toFixed(3)} USDT`;
  return `${usd.toFixed(2)} USDT`;
}

// ── Exchange brand colours ─────────────────────────────────────────────────

const EX_COLORS = {
  binance: { color: "#f3ba2f", label: "Binance" },
  bybit:   { color: "#ffc200", label: "Bybit"   },
  kucoin:  { color: "#0dbb6f", label: "KuCoin"  },
  bitget:  { color: "#00c6ff", label: "Bitget"  },
};

function exInfo(name) {
  return EX_COLORS[name] ?? { color: "var(--app-text-muted)", label: name };
}

// ── Net-profit colour ──────────────────────────────────────────────────────

function netColor(v) {
  if (v == null) return "var(--app-text-dimmer)";
  if (v >= 0.5)  return "var(--app-success)";
  if (v >= 0.1)  return "var(--app-warning)";
  if (v >= 0)    return "var(--app-text-dimmer)";
  return "var(--app-danger)";
}

// ── MiniSparkline — pure SVG price chart (no external library) ─────────────

function MiniSparkline({ samples, color, height = 32 }) {
  if (!samples || samples.length < 2) return null;

  const prices = samples.map((s) => s.price);
  const min    = Math.min(...prices);
  const max    = Math.max(...prices);
  const range  = (max - min) || (prices[prices.length - 1] * 0.0001) || 1;

  const W   = 100;
  const H   = height;
  const pad = 2.5;
  const n   = prices.length;

  const pts = prices.map((p, i) => [
    (i / (n - 1)) * W,
    pad + (H - 2 * pad) * (1 - (p - min) / range),
  ]);

  const line = pts
    .map((pt, i) => `${i === 0 ? "M" : "L"}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`)
    .join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      style={{ display: "block", overflow: "hidden", borderRadius: 3 }}
    >
      <path d={area} fill={color} fillOpacity="0.12" />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── ExchangePanel ──────────────────────────────────────────────────────────

function ExchangePanel({ side, exchange, price, feeRate, feeTaxRate, sparkline, onChartClick }) {
  const { color, label } = exInfo(exchange);
  const isBuy      = side === "buy";
  const effRate    = feeRate * (1 + feeTaxRate);
  const taxPct     = (feeTaxRate * 100).toFixed(0);
  const sparkColor = isBuy ? "var(--app-success)" : "var(--app-danger)";
  const hasData    = sparkline && sparkline.length >= 2;
  const clickable  = hasData && !!onChartClick;

  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="flex-1 flex flex-col gap-1.5 px-3 py-2.5 min-w-0"
      onClick={clickable ? onChartClick : undefined}
      onMouseEnter={() => { if (clickable) setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      style={{
        background:   isBuy ? "var(--app-success-tint)" : "var(--app-danger-tint)",
        borderRight:  isBuy ? "1px solid var(--app-border-0)" : undefined,
        cursor:       clickable ? "pointer" : "default",
        transition:   "opacity 0.15s, filter 0.15s",
        opacity:      hovered ? 0.82 : 1,
        filter:       hovered ? `drop-shadow(0 0 6px ${color}44)` : "none",
        position:     "relative",
      }}
    >
      {/* Side label · effective fee rate */}
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[9px] font-bold uppercase tracking-widest"
          style={{ color: isBuy ? "var(--app-success)" : "var(--app-danger)" }}
        >
          {isBuy ? "Buy" : "Sell"}
        </span>
        <span
          className="text-[9px] font-mono font-semibold"
          style={{ color: "var(--app-text-muted)" }}
          title={
            feeTaxRate > 0
              ? `${fmtFeePct(feeRate)} taker + ${taxPct}% tax = ${fmtFeePct(effRate)} effective`
              : `${fmtFeePct(feeRate)} taker fee`
          }
        >
          {fmtFeePct(effRate)}
          {feeTaxRate > 0 && (
            <span className="ml-0.5" style={{ color: "var(--app-text-dimmer)" }}>*</span>
          )}
        </span>
      </div>

      {/* Exchange logo + name */}
      <div className="flex items-center gap-1.5 min-w-0">
        <ExchangeIcon name={exchange} size={18} />
        <span
          className={`text-sm font-bold truncate leading-tight rounded px-1 ${isBuy ? "exchange-name-buy" : "exchange-name-sell"}`}
          style={{ color }}
        >
          {label}
        </span>
        {/* Expand icon — top right corner */}
        {clickable && (
          <span style={{
            marginLeft: "auto",
            fontSize: 9, color: color, opacity: hovered ? 0.9 : 0.3,
            flexShrink: 0, transition: "opacity 0.15s",
            pointerEvents: "none",
          }}>⛶</span>
        )}
      </div>

      {/* Price */}
      <span
        className="text-[15px] font-extrabold font-mono tabular-nums leading-tight truncate"
        style={{ color: "var(--app-text-bright)" }}
        title={fmtPrice(price)}
      >
        {fmtPrice(price)}
      </span>

      {/* Sparkline chart */}
      <div style={{ position: "relative", borderRadius: 5, overflow: "hidden" }}>
        <MiniSparkline samples={sparkline} color={sparkColor} height={32} />
        {clickable && hovered && (
          <div style={{
            position: "absolute", inset: 0,
            background: `${color}10`,
            borderRadius: 5,
            pointerEvents: "none",
          }} />
        )}
      </div>
    </div>
  );
}

// ── TransferRow — matched network strip ────────────────────────────────────

function TransferRow({ fees, buyAsk }) {
  const network        = fees.withdrawNetwork;
  const routes         = fees.routesConsidered ?? 1;
  const speedTier      = fees.speedTier;
  const verified       = fees.addressVerified;
  const confirmedCount = fees.addressConfirmedCount ?? 0;
  const totalUSD  = fees.totalTransferFeeInCoin != null ? fees.totalTransferFeeInCoin * buyAsk : null;

  const speedColor =
    speedTier === "fast"   ? "var(--app-success)" :
    speedTier === "medium" ? "var(--app-warning)"  :
    "var(--app-text-dim)";

  const speedBg =
    speedTier === "fast"   ? "var(--app-success-soft)" :
    speedTier === "medium" ? "var(--app-warning-soft)"  :
    "var(--app-surface-2)";

  const speedBorder =
    speedTier === "fast"   ? "var(--app-success-border)" :
    speedTier === "medium" ? "var(--app-warning-border)"  :
    "var(--app-border-1)";

  return (
    <div
      className="px-3 py-1.5 flex items-center justify-between gap-2"
      style={{
        borderTop:  "1px solid var(--app-border-0)",
        background: routes > 1 ? "var(--app-success-tint)" : "var(--app-surface-1)",
      }}
    >
      {/* Left: via NETWORK pill */}
      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
        <span className="text-[9px] uppercase tracking-wider flex-shrink-0" style={{ color: "var(--app-text-muted)" }}>
          via
        </span>

        {network ? (
          <span
            className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide flex items-center gap-1 flex-shrink-0"
            style={{ background: speedBg, color: speedColor, border: `1px solid ${speedBorder}` }}
            title={
              (speedTier === "fast"   ? "Fast — usually credited in <5 min. " :
               speedTier === "medium" ? "Medium speed — typically 5–30 min. " : "") +
              (routes > 1 ? `Cheapest of ${routes} compatible networks.` : "Only one compatible network.")
            }
          >
            {network}
            {verified === true  && <span title={`Contract address verified · Deposit address confirmed ${confirmedCount}/10 times`}>✓</span>}
          </span>
        ) : (
          <span className="text-[9px] italic" style={{ color: "var(--app-text-muted)" }}>
            no common network
          </span>
        )}

        {routes > 1 && (
          <span
            className="px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-wider flex-shrink-0"
            style={{ background: "var(--app-success-strong)", color: "var(--app-success)", border: "1px solid var(--app-success-border)" }}
            title={`Cheapest of ${routes} networks supported by both exchanges`}
          >
            ★ best of {routes}
          </span>
        )}
      </div>

      {/* Right: total transfer cost */}
      {totalUSD != null && (
        <span
          className="text-[10px] font-mono font-semibold flex-shrink-0"
          style={{ color: totalUSD > 0 ? "var(--app-danger)" : "var(--app-text-dim)" }}
          title="Total transfer cost (withdraw + deposit) in USDT at current buy price"
        >
          ≈ {fmtUSDT(totalUSD)}
        </span>
      )}
    </div>
  );
}

// ── Fee footer — withdraw + deposit breakdown ──────────────────────────────

function FeeFooter({ fees, symbol, buyAsk }) {
  const wdFee  = fees.withdrawFeeInCoin;
  const depFee = fees.depositFeeInCoin;
  const wdUSD  = wdFee  != null ? wdFee  * buyAsk : null;
  const depUSD = depFee != null ? depFee * buyAsk : null;
  const source = fees.feeSource;

  return (
    <div
      className="px-4 py-2 flex items-center flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono"
      style={{
        borderTop:  "1px solid var(--app-border-0)",
        background: "var(--app-surface-1)",
        color:      "var(--app-text-muted)",
      }}
    >
      {/* Withdraw */}
      <span className="flex items-center gap-1 flex-wrap">
        <span style={{ color: "var(--app-text-dim)" }}>Withdraw</span>
        {wdFee != null && wdFee > 0 ? (
          <>
            <span style={{ color: "var(--app-danger)" }}>
              −{fmtCoinFee(wdFee, symbol)}
            </span>
            {wdUSD != null && (
              <span style={{ color: "var(--app-text-dim)" }}>
                (~{fmtUSDT(wdUSD)})
              </span>
            )}
            {source === "static" && (
              <span
                className="px-1 rounded text-[8px] font-bold"
                style={{
                  background: "var(--app-warning-soft)",
                  color:      "var(--app-warning)",
                  border:     "1px solid var(--app-warning-border)",
                }}
                title="Fee from static table — verify on exchange"
              >
                ~approx
              </span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--app-text-dim)" }}>free</span>
        )}
      </span>

      <span style={{ color: "var(--app-border-1)" }}>·</span>

      {/* Deposit */}
      <span className="flex items-center gap-1 flex-wrap">
        <span style={{ color: "var(--app-text-dim)" }}>Deposit</span>
        {depFee != null && depFee > 0 ? (
          <>
            <span style={{ color: "var(--app-danger)" }}>
              −{fmtCoinFee(depFee, symbol)}
            </span>
            {depUSD != null && (
              <span style={{ color: "var(--app-text-dim)" }}>
                (~{fmtUSDT(depUSD)})
              </span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--app-text-dim)" }}>free</span>
        )}
      </span>
    </div>
  );
}

// ── Main card ──────────────────────────────────────────────────────────────

export const SpotArbCard = memo(function SpotArbCard({ opp, tradeAmount = 100, movements, buySparkline, sellSparkline, targetedNetProfit = 0.5, botMinNetProfitPct = null, botMinTimesHit = null, botTakeProfitPct = null, botMaxMovementPct = null, botPriceMovementWindow = null, onChartClick }) {
  // ── Price movement windows — hook must be before any early return ──────────────────────────────
  const priceMovement = useMemo(() => {
    const labels = ["4H", "8H", "12H", "24H"];
    if (!movements) return labels.map((label) => ({ label, pct: null }));
    return labels.map((label) => ({ label, pct: movements[label] ?? null }));
  }, [movements]);

  // Guard: null opp after all hooks to avoid Rules-of-Hooks violation
  if (!opp) return null;

  const fees = opp.fees ?? {};
  const net  = opp.netProfitPct ?? null;
  const nc   = netColor(net);

  // Projected profit breakdown
  const {
    buyFeeEff, sellFeeEff, tdsRate,
    tokens, sellValue, grossProfit,
    buyFee, sellFee, tdsAmount, wdFee,
    profit,
  } = computeProjectedProfit(opp, tradeAmount);

  const projColor  = profit >= 0 ? "var(--app-success)"        : "var(--app-danger)";
  const projBg     = profit >= 0 ? "var(--app-success-soft)"   : "var(--app-danger-soft)";
  const projBorder = profit >= 0 ? "var(--app-success-border)" : "var(--app-danger-border)";

  return (
    <div
      className="rounded-xl overflow-hidden flex flex-col"
      style={{ background: "var(--app-surface-0)", border: "1px solid var(--app-border-0)" }}
    >
      {/* ── Header: symbol · gross spread · net profit ── */}
      <div
        className="flex items-center justify-between px-4 py-2.5 gap-3"
        style={{ background: "var(--app-surface-1)", borderBottom: "1px solid var(--app-border-0)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <CoinIcon symbol={opp.symbol} size={20} />
          <span className="text-sm font-extrabold tracking-wide uppercase" style={{ color: "var(--app-text-bright)" }}>
            {opp.symbol}
          </span>
          <span className="text-[10px] font-semibold" style={{ color: "var(--app-text-muted)" }}>
            /USDT
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span
            className="px-2 py-0.5 rounded-full text-[10px] font-mono"
            style={{ color: "var(--app-text-muted)", background: "rgba(148,163,184,0.08)" }}
          >
            {fmtPct(opp.priceDiffPct)}
          </span>
          <span
            className="px-2 py-0.5 rounded-full text-xs font-bold font-mono whitespace-nowrap"
            title="Net profit after taker fees (incl. tax) + transfer fees. Does not include TDS."
            style={{
              background: net != null && net >= 0 ? "var(--app-success-soft)" : "var(--app-danger-soft)",
              color:      nc,
              border:     `1px solid ${net != null && net >= 0 ? "var(--app-success-border)" : "var(--app-danger-border)"}`,
            }}
          >
            {fmtPct(net)}
          </span>
        </div>
      </div>

      {/* ── Projected profit on trade amount ── */}
      <div
        className="px-4 py-1.5 flex items-center justify-between gap-2"
        style={{ background: projBg, borderBottom: "1px solid var(--app-border-0)" }}
        title={
          `BUY  $${tradeAmount.toFixed(2)} @ ${opp.buyExchange}\n` +
          `  Tokens bought:  ${tokens.toFixed(6)}\n` +
          `  Buy fee (${(buyFeeEff * 100).toFixed(3)}%): −$${buyFee.toFixed(4)}\n\n` +
          `SELL  $${sellValue.toFixed(4)} @ ${opp.sellExchange}\n` +
          `  Gross profit:   +$${grossProfit.toFixed(4)}\n` +
          `  Sell fee (${(sellFeeEff * 100).toFixed(3)}%): −$${sellFee.toFixed(4)}\n` +
          `  TDS (${(tdsRate * 100).toFixed(0)}%):         −$${tdsAmount.toFixed(4)}\n` +
          `  Withdrawal fee: −$${wdFee.toFixed(4)}\n\n` +
          `Net profit: ${profit >= 0 ? "+" : ""}$${profit.toFixed(4)}`
        }
      >
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
          Projected on ${tradeAmount}
        </span>
        <span
          className="px-2 py-0.5 rounded-md text-xs font-extrabold font-mono"
          style={{ background: "var(--app-surface-0)", color: projColor, border: `1px solid ${projBorder}` }}
        >
          {profit >= 0 ? "+" : "−"}{fmtUSDT(Math.abs(profit))?.replace(" USDT", "")} USDT
        </span>
      </div>

      {/* TDS note */}
      {(fees.tdsRate ?? 0) > 0 && (
        <div
          className="px-4 py-0.5 flex items-center justify-end text-[9px] font-mono"
          style={{ background: projBg, borderBottom: "1px solid var(--app-border-0)", color: "var(--app-text-dim)", opacity: 0.75 }}
          title={`1% TDS on sell value ≈$${sellValue.toFixed(2)}. Already included above.`}
        >
          incl. 1% TDS −{fmtUSDT(tdsAmount)}
        </div>
      )}

      {/* ── Exchange panels ── */}
      <div className="flex">
        <ExchangePanel
          side="buy"
          exchange={opp.buyExchange}
          price={opp.buyAsk}
          feeRate={fees.buyFeeRate ?? 0.001}
          feeTaxRate={fees.feeTaxRate ?? 0}
          sparkline={buySparkline}
          onChartClick={onChartClick}
        />
        <ExchangePanel
          side="sell"
          exchange={opp.sellExchange}
          price={opp.sellBid}
          feeRate={fees.sellFeeRate ?? 0.001}
          feeTaxRate={fees.feeTaxRate ?? 0}
          sparkline={sellSparkline}
          onChartClick={onChartClick}
        />
      </div>

      {/* ── Profit Stats (Times Hit / Highest / Target) ── */}
      {(() => {
        const hits       = opp.profitTimesHit ?? 0;
        const highest    = opp.highestNetProfitPct;
        const hasHits    = hits > 0;
        const hasHistory = highest !== null && highest !== undefined;

        // Bot comparison flags
        const hasBotCfg       = botMinNetProfitPct !== null || botMinTimesHit !== null || botTakeProfitPct !== null;
        const hitsNeed        = botMinTimesHit ?? 0;
        const hitsPass        = botMinTimesHit !== null ? hits >= hitsNeed : hasHits;
        const targetThreshold = botTakeProfitPct ?? botMinNetProfitPct ?? targetedNetProfit;
        const cardNet         = opp.netProfitPct ?? null;
        const targetPass      = cardNet !== null ? cardNet >= targetThreshold : false;
        const botPass         = hasBotCfg ? (hitsPass && targetPass) : hasHits;

        const passColor = "var(--app-success)";
        const failColor = "#ef4444";
        const dimColor  = "var(--app-text-dim)";

        return (
          <div
            className="px-3 pt-2 pb-2 flex flex-col gap-1.5"
            style={{
              borderTop: "1px solid var(--app-border-0)",
              background: botPass ? "var(--app-success-soft)" : "var(--app-surface-1)",
            }}
          >
            {/* Row: label + badge */}
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                {hasBotCfg ? "Bot Filter Match" : "Net Profit Stats"}
              </span>
              {botPass ? (
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full tracking-wider"
                  style={{ background: "var(--app-success-tint)", color: passColor, border: "1px solid var(--app-success-border)" }}
                >
                  ✓ QUALIFIES
                </span>
              ) : (
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full tracking-wider"
                  style={{ background: "var(--app-surface-2)", color: "var(--app-text-dimmer)", border: "1px solid var(--app-border-1)" }}
                >
                  ○ NOT YET
                </span>
              )}
            </div>
            {/* 3 stats in a row */}
            <div className="grid grid-cols-3 gap-2">
              {/* 1. Times Hit vs bot minTimesHit */}
              <div className="flex flex-col">
                <div className="flex items-baseline gap-0.5 leading-tight">
                  <span
                    className="text-sm font-bold tabular-nums"
                    style={{ color: hitsPass ? passColor : (hasHits ? dimColor : dimColor) }}
                  >
                    {hits}
                  </span>
                  {botMinTimesHit !== null && botMinTimesHit > 0 && (
                    <span className="text-[9px] font-bold tabular-nums" style={{ color: hitsPass ? passColor : failColor }}>
                      /{hitsNeed}
                    </span>
                  )}
                </div>
                <span className="text-[9px] uppercase tracking-wide font-medium leading-tight mt-0.5" style={{ color: dimColor }}>
                  Times Hit
                </span>
                <span className="text-[8px] tracking-wide" style={{ color: "var(--app-text-dimmer)" }}>
                  {botMinTimesHit !== null ? (hitsPass ? "✓ meets min" : `need ${hitsNeed}×`) : "4H window"}
                </span>
              </div>
              {/* 2. Highest Net Profit % */}
              <div className="flex flex-col">
                <span
                  className="text-sm font-bold font-mono leading-tight"
                  style={{ color: hasHistory ? "var(--app-warning)" : dimColor }}
                >
                  {hasHistory ? fmtPct(highest) : "—"}
                </span>
                <span className="text-[9px] uppercase tracking-wide font-medium leading-tight mt-0.5" style={{ color: dimColor }}>
                  Highest
                </span>
                <span className="text-[8px] tracking-wide" style={{ color: "var(--app-text-dimmer)" }}>4H peak</span>
              </div>
              {/* 3. Target threshold — shows bot's minNetProfitPct if available */}
              <div className="flex flex-col">
                <span
                  className="text-sm font-bold font-mono leading-tight"
                  style={{ color: hasBotCfg ? (targetPass ? passColor : failColor) : "var(--app-text-muted)" }}
                >
                  {fmtPct(targetThreshold)}
                </span>
                <span className="text-[9px] uppercase tracking-wide font-medium leading-tight mt-0.5" style={{ color: dimColor }}>
                  Target
                </span>
                <span className="text-[8px] tracking-wide" style={{ color: "var(--app-text-dimmer)" }}>
                  {hasBotCfg ? (targetPass ? "✓ qualifies" : "too low") : "threshold"}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Price movement ── */}
      {(() => {
        const movFilterActive = botMaxMovementPct != null && botMaxMovementPct > 0;
        return (
          <div className="px-3 pt-2 pb-2" style={{ borderTop: "1px solid var(--app-border-0)" }}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
                Price Movement
              </span>
              {movFilterActive && (
                <span className="text-[8px] font-mono" style={{ color: "var(--app-text-dimmer)" }}>
                  cap: 0% – +{botMaxMovementPct}%
                </span>
              )}
            </div>
            <div className="grid grid-cols-4 gap-1">
              {priceMovement.map(({ label, pct }) => {
                const isActiveWindow = movFilterActive && label === botPriceMovementWindow;
                let pass = null;
                if (isActiveWindow && pct !== null) {
                  pass = pct >= 0 && pct <= botMaxMovementPct;
                }
                const bg = isActiveWindow
                  ? pass === true  ? "var(--app-success-soft)"
                  : pass === false ? "var(--app-danger-soft)"
                  : "var(--app-surface-2)"
                  : "var(--app-surface-2)";
                const border = isActiveWindow
                  ? pass === true  ? "1px solid var(--app-success-border)"
                  : pass === false ? "1px solid var(--app-danger-border)"
                  : "1px solid var(--app-border-1)"
                  : "1px solid var(--app-border-0)";
                const pctColor = pct == null
                  ? "var(--app-text-dimmer)"
                  : isActiveWindow
                    ? pass === true  ? "var(--app-success)"
                    : pass === false ? "var(--app-danger)"
                    : "var(--app-text-dim)"
                  : pct >= 0 ? "var(--app-success)" : "var(--app-danger)";

                return (
                  <div
                    key={label}
                    className="flex flex-col items-center rounded-md py-1"
                    style={{ background: bg, border }}
                    title={
                      isActiveWindow
                        ? pass === true
                          ? `✓ Passes bot filter: movement is positive and ≤ ${botMaxMovementPct}%`
                          : pass === false
                            ? pct < 0
                              ? `✗ Fails bot filter: negative movement (price dropping)`
                              : `✗ Fails bot filter: movement ${pct?.toFixed(2)}% exceeds cap of ${botMaxMovementPct}%`
                            : "Bot movement filter active — no data yet"
                        : undefined
                    }
                  >
                    <span
                      className="text-[8px] font-bold uppercase tracking-wider"
                      style={{ color: isActiveWindow ? (pass === true ? "var(--app-success)" : pass === false ? "var(--app-danger)" : "var(--app-text-dim)") : "var(--app-text-dim)" }}
                    >
                      {label}{isActiveWindow ? " ●" : ""}
                    </span>
                    <span
                      className="text-[10px] font-bold font-mono tabular-nums leading-tight"
                      style={{ color: pctColor }}
                    >
                      {pct == null ? "—" : (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%"}
                    </span>
                    {isActiveWindow && pass !== null && (
                      <span className="text-[9px] font-bold leading-none mt-0.5" style={{ color: pass ? "var(--app-success)" : "var(--app-danger)" }}>
                        {pass ? "✓" : "✗"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Transfer network strip ── */}
      <TransferRow fees={fees} buyAsk={opp.buyAsk} />

      {/* ── Fee footer: withdraw + deposit breakdown ── */}
      <FeeFooter fees={fees} symbol={opp.symbol} buyAsk={opp.buyAsk} />
    </div>
  );
});
