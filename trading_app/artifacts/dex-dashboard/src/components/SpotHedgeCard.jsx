import { memo, useEffect, useMemo, useState } from "react";
import { CoinIcon }     from "@/components/CoinIcon";
import { ExchangeIcon } from "@/components/ExchangeIcon";

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtPrice(v) {
  if (v == null || !isFinite(v)) return "—";
  if (v >= 1_000) return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1)     return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function fmtPct(v, showSign = true) {
  if (v == null || !isFinite(v)) return "—";
  const sign = showSign && v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(3)}%`;
}

function fmtFeePct(r) {
  return `${(r * 100).toFixed(2)}%`;
}

// ── Net profit % = Spread − Taker Fees − TDS ────────────────────────────────
function computeSpreadNetPct(opp) {
  const fees = opp?.fees ?? {};
  const spread = opp?.priceDiffPct;
  if (spread == null || !isFinite(spread)) return null;
  const buyFeeEff  = (fees.buyFeeRate  ?? 0.001) * (1 + (fees.feeTaxRate ?? 0)) * 100;
  const sellFeeEff = (fees.sellFeeRate ?? 0.001) * (1 + (fees.feeTaxRate ?? 0)) * 100;
  const tds        = (fees.tdsRate ?? 0.01) * 100;
  return spread - buyFeeEff - sellFeeEff - tds;
}

function fmtCrossTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 60_000)    return `${Math.round(diff / 1_000)}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  return `${(diff / 3_600_000).toFixed(1)}h`;
}

// Format a duration in ms between two chip crossings (e.g. "1h 23m", "45m", "2d 3h")
function fmtDuration(ms) {
  if (ms == null || ms <= 0) return null;
  const s = Math.round(ms / 1_000);
  if (s < 60)  return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60)  return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24)  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

// ── Brand colours ───────────────────────────────────────────────────────────

const EX_COLORS = {
  binance: { color: "#f3ba2f", label: "Binance" },
  bybit:   { color: "#ffc200", label: "Bybit"   },
  kucoin:  { color: "#0dbb6f", label: "KuCoin"  },
  bitget:  { color: "#00c6ff", label: "Bitget"  },
};

function exInfo(name) {
  return EX_COLORS[name] ?? { color: "var(--app-text-muted)", label: name };
}

function netColor(v) {
  if (v == null) return "var(--app-text-dimmer)";
  if (v >= 0.5)  return "var(--app-success)";
  if (v >= 0.1)  return "var(--app-warning)";
  if (v >= 0)    return "var(--app-text-dimmer)";
  return "var(--app-danger)";
}

// ── MiniSparkline ────────────────────────────────────────────────────────────

function MiniSparkline({ samples, color, height = 28 }) {
  if (!samples || samples.length < 2) return null;
  const prices = samples.map((s) => s.price);
  const min    = Math.min(...prices);
  const max    = Math.max(...prices);
  const range  = (max - min) || (prices[prices.length - 1] * 0.0001) || 1;
  const W = 100, H = height, pad = 2.5, n = prices.length;
  const pts = prices.map((p, i) => [
    (i / (n - 1)) * W,
    pad + (H - 2 * pad) * (1 - (p - min) / range),
  ]);
  const line = pts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={height}
      style={{ display: "block", overflow: "hidden", borderRadius: 3 }}>
      <path d={area} fill={color} fillOpacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Binary search nearest ts ─────────────────────────────────────────────────

function binaryNearest(data, ts) {
  if (!data || !data.length) return null;
  let lo = 0, hi = data.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].ts < ts) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return data[0];
  if (lo >= data.length) return data[data.length - 1];
  const before = data[lo - 1], after = data[lo];
  return Math.abs(before.ts - ts) <= Math.abs(after.ts - ts) ? before : after;
}

// ── Inline Absolute-Price Crossover Chart ─────────────────────────────────────
// Shows BUY's ASK and SELL's BID in absolute price space on the same Y axis.
// Fills green where sellBid > buyAsk (positive spread), red where buyAsk > sellBid.
// Crossing points (where lines intersect) are marked with vertical dotted lines.

function InlineAbsPriceChart({ buyData, sellData, buyExchange, sellExchange, height = 68, onExpand, onCrossings }) {
  const W = 300, H = height;
  const PAD = { t: 14, r: 4, b: 4, l: 4 };

  // Align sell series to buy timestamps using nearest-point lookup
  const aligned = useMemo(() => {
    if (!buyData?.length || !sellData?.length) return [];
    return buyData
      .filter((b) => isFinite(b.price) && isFinite(b.ts))
      .map((b) => {
        const s = binaryNearest(sellData, b.ts);
        if (!s || !s.price) return null;
        return { ts: b.ts, ask: b.price, bid: s.price };
      })
      .filter(Boolean);
  }, [buyData, sellData]);

  const buyCol  = exInfo(buyExchange).color;
  const sellCol = exInfo(sellExchange).color;

  // Count crossings unconditionally (before any early return) so hooks order is stable
  const crossingsCount = useMemo(() => {
    if (aligned.length < 2) return 0;
    let count = 0;
    for (let i = 0; i < aligned.length - 1; i++) {
      const cs = aligned[i].bid - aligned[i].ask;
      const ns = aligned[i + 1].bid - aligned[i + 1].ask;
      if ((cs >= 0) !== (ns >= 0)) count++;
    }
    return count;
  }, [aligned]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onCrossings?.(crossingsCount); }, [crossingsCount]);

  const chartGeom = useMemo(() => {
    if (aligned.length < 2) return null;
    const allPrices = aligned.flatMap((d) => [d.ask, d.bid]).filter(isFinite);
    const minP = Math.min(...allPrices);
    const maxP = Math.max(...allPrices);
    const rangeP = (maxP - minP) || (minP * 0.001) || 1;
    const padP   = rangeP * 0.22;
    const p0 = minP - padP, p1 = maxP + padP;
    const minTs = aligned[0].ts, maxTs = aligned[aligned.length - 1].ts;
    const cW = W - PAD.l - PAD.r;
    const cH = H - PAD.t - PAD.b;
    const xOf = (ts)    => PAD.l + ((ts - minTs) / ((maxTs - minTs) || 1)) * cW;
    const yOf = (price) => PAD.t + (1 - (price - p0) / ((p1 - p0) || 1)) * cH;
    const fills = [], crossings = [];
    for (let i = 0; i < aligned.length - 1; i++) {
      const cur  = aligned[i];
      const next = aligned[i + 1];
      const curSpread  = cur.bid  - cur.ask;
      const nextSpread = next.bid - next.ask;
      const x0 = xOf(cur.ts),  y0ask = yOf(cur.ask),  y0bid = yOf(cur.bid);
      const x1 = xOf(next.ts), y1ask = yOf(next.ask), y1bid = yOf(next.bid);
      if ((curSpread >= 0) === (nextSpread >= 0)) {
        fills.push({
          d: `M${x0.toFixed(1)},${y0ask.toFixed(1)} L${x1.toFixed(1)},${y1ask.toFixed(1)} L${x1.toFixed(1)},${y1bid.toFixed(1)} L${x0.toFixed(1)},${y0bid.toFixed(1)} Z`,
          positive: curSpread >= 0,
        });
      } else {
        const t  = -curSpread / (nextSpread - curSpread);
        const cx = x0 + t * (x1 - x0);
        const cy = (y0ask + t * (y1ask - y0ask) + y0bid + t * (y1bid - y0bid)) / 2;
        crossings.push(cx);
        fills.push({
          d: `M${x0.toFixed(1)},${y0ask.toFixed(1)} L${cx.toFixed(1)},${cy.toFixed(1)} L${x0.toFixed(1)},${y0bid.toFixed(1)} Z`,
          positive: curSpread >= 0,
        });
        fills.push({
          d: `M${cx.toFixed(1)},${cy.toFixed(1)} L${x1.toFixed(1)},${y1ask.toFixed(1)} L${x1.toFixed(1)},${y1bid.toFixed(1)} Z`,
          positive: nextSpread >= 0,
        });
      }
    }
    const askPts    = aligned.map((d) => [xOf(d.ts), yOf(d.ask)]);
    const bidPts    = aligned.map((d) => [xOf(d.ts), yOf(d.bid)]);
    const last      = aligned[aligned.length - 1];
    const spreadNow = last ? ((last.bid - last.ask) / last.ask) * 100 : null;
    const spreadPos = spreadNow != null && spreadNow >= 0;
    return { cW, cH, fills, crossings, askPts, bidPts, spreadNow, spreadPos };
  }, [aligned, height]);

  if (!chartGeom) {
    return (
      <div style={{
        height, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, color: "var(--app-text-dimmer)", background: "rgba(0,0,0,0.12)",
        borderRadius: 6,
      }}>
        Chart loading…
      </div>
    );
  }

  const { cW, cH, fills, crossings, askPts, bidPts, spreadNow, spreadPos } = chartGeom;

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{ position: "relative", cursor: onExpand ? "zoom-in" : "default" }}
        onClick={onExpand}
        title={onExpand ? "Click to open full chart" : undefined}
      >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        style={{ display: "block", overflow: "hidden", borderRadius: 6 }}
      >
        {/* Background */}
        <rect x={PAD.l} y={PAD.t} width={cW} height={cH} fill="rgba(0,0,0,0.22)" rx="3" />

        {/* Spread fill segments */}
        {fills.map((f, i) => (
          <path key={i} d={f.d}
            fill={f.positive ? "rgba(34,197,94,0.22)" : "rgba(248,113,113,0.22)"}
            stroke="none"
          />
        ))}

        {/* Crossing markers — vertical dotted lines */}
        {crossings.map((cx, i) => (
          <line key={i} x1={cx.toFixed(1)} y1={PAD.t} x2={cx.toFixed(1)} y2={PAD.t + cH}
            stroke="rgba(255,255,255,0.45)" strokeWidth="0.8" strokeDasharray="2,3" />
        ))}

        {/* BID line — dashed (sell exchange color) */}
        {bidPts.length >= 2 && (
          <path d={mkPath(bidPts)} fill="none" stroke={sellCol}
            strokeWidth="1.5" strokeDasharray="5,3"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ filter: `drop-shadow(0 0 3px ${sellCol}66)` }} />
        )}

        {/* ASK line — solid (buy exchange color) */}
        {askPts.length >= 2 && (
          <path d={mkPath(askPts)} fill="none" stroke={buyCol}
            strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ filter: `drop-shadow(0 0 3px ${buyCol}66)` }} />
        )}

        {/* Legend: ASK dot + label */}
        <circle cx={PAD.l + 5} cy={PAD.t - 5} r={3} fill={buyCol} />
        <text x={PAD.l + 11} y={PAD.t - 2} fontSize="7.5" fill={buyCol} fontFamily="monospace" fontWeight="bold">
          ASK
        </text>

        {/* Legend: BID dashed line + label */}
        <line x1={PAD.l + 30} y1={PAD.t - 5} x2={PAD.l + 40} y2={PAD.t - 5}
          stroke={sellCol} strokeWidth="2" strokeDasharray="3,2" />
        <text x={PAD.l + 44} y={PAD.t - 2} fontSize="7.5" fill={sellCol} fontFamily="monospace" fontWeight="bold">
          BID
        </text>

        {/* Crossing count badge — moved to HTML overlay below */}

        {/* Current spread badge (top-right) */}
        {spreadNow != null && (() => {
          const bw = 50;
          return (
            <>
              <rect x={PAD.l + cW - bw} y={PAD.t - 12} width={bw} height={12}
                fill={spreadPos ? "rgba(34,197,94,0.15)" : "rgba(248,113,113,0.15)"} rx="3" />
              <text x={PAD.l + cW - 3} y={PAD.t - 3}
                fontSize="7.5" fill={spreadPos ? "#22c55e" : "#f87171"}
                fontFamily="monospace" fontWeight="bold" textAnchor="end">
                {spreadNow >= 0 ? "+" : ""}{spreadNow.toFixed(3)}%
              </text>
            </>
          );
        })()}

        {/* Border */}
        <rect x={PAD.l} y={PAD.t} width={cW} height={cH}
          fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" rx="3" />
      </svg>
      </div>
    </div>
  );
}

// ── Inline Dual-Price Chart ──────────────────────────────────────────────────
// Normalises both series to % change from their first sample so crossing
// and divergence patterns are clearly visible regardless of absolute price.
// H/L markers show the historical widest and narrowest spread timestamps.

function normalise(data) {
  if (!data || data.length < 2) return [];
  const base = data[0].price;
  if (!base) return [];
  return data.map((d) => ({ ts: d.ts, pct: ((d.price - base) / base) * 100 }));
}

function mkPath(pts) {
  return pts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(" ");
}

function InlineDualChart({ buyData, sellData, buyExchange, sellExchange, height = 80, onExpand }) {
  const W = 300, H = height;
  const PAD = { t: 14, r: 4, b: 18, l: 4 }; // extra bottom for H/L badges

  const normBuy  = useMemo(() => normalise(buyData),  [buyData]);
  const normSell = useMemo(() => normalise(sellData), [sellData]);

  // ── Spread H/L from raw prices ─────────────────────────────────────────────
  const spreadPoints = useMemo(() => {
    if (!buyData?.length || !sellData?.length) return [];
    return buyData
      .filter((b) => isFinite(b.price) && isFinite(b.ts))
      .map((b) => {
        const s = binaryNearest(sellData, b.ts);
        if (!s || !b.price || !s.price) return null;
        return { ts: b.ts, spread: ((s.price - b.price) / b.price) * 100 };
      })
      .filter(Boolean);
  }, [buyData, sellData]);

  const { highSpread, lowSpread } = useMemo(() => {
    if (!spreadPoints.length) return { highSpread: null, lowSpread: null };
    const h = spreadPoints.reduce((a, b) => b.spread > a.spread ? b : a, spreadPoints[0]);
    const l = spreadPoints.reduce((a, b) => b.spread < a.spread ? b : a, spreadPoints[0]);
    return { highSpread: h, lowSpread: l };
  }, [spreadPoints]);

  const dualGeom = useMemo(() => {
    if (normBuy.length < 2 && normSell.length < 2) return null;
    const allTs  = [...normBuy, ...normSell].map((d) => d.ts).filter(isFinite);
    const allPct = [...normBuy, ...normSell].map((d) => d.pct).filter(isFinite);
    if (!allTs.length) return null;
    const minTs = Math.min(...allTs), maxTs = Math.max(...allTs);
    const minP  = Math.min(...allPct, 0);
    const maxP  = Math.max(...allPct, 0);
    const rangeP = (maxP - minP) || 0.5;
    const padP  = rangeP * 0.18;
    const p0 = minP - padP, p1 = maxP + padP;
    const cW = W - PAD.l - PAD.r;
    const cH = H - PAD.t - PAD.b;
    const xOf = (ts)  => PAD.l + ((ts - minTs) / ((maxTs - minTs) || 1)) * cW;
    const yOf = (pct) => PAD.t + (1 - (pct - p0) / ((p1 - p0) || 1)) * cH;
    const zeroY   = yOf(0);
    const buyPts  = normBuy .filter((d) => isFinite(d.pct) && isFinite(d.ts)).map((d) => [xOf(d.ts), yOf(d.pct)]);
    const sellPts = normSell.filter((d) => isFinite(d.pct) && isFinite(d.ts)).map((d) => [xOf(d.ts), yOf(d.pct)]);
    const lastBuy  = buyData?.length  ? buyData[buyData.length - 1]  : null;
    const lastSell = sellData?.length ? sellData[sellData.length - 1] : null;
    const spreadNow = (lastBuy?.price && lastSell?.price)
      ? ((lastSell.price - lastBuy.price) / lastBuy.price) * 100
      : null;
    const hX = highSpread ? Math.max(PAD.l + 2, Math.min(PAD.l + cW - 2, xOf(highSpread.ts))) : null;
    const lX = lowSpread  ? Math.max(PAD.l + 2, Math.min(PAD.l + cW - 2, xOf(lowSpread.ts)))  : null;
    return { cW, cH, zeroY, buyPts, sellPts, spreadNow, hX, lX };
  }, [normBuy, normSell, buyData, sellData, highSpread, lowSpread, height]);

  const buyCol  = exInfo(buyExchange).color;
  const sellCol = exInfo(sellExchange).color;
  const buyLbl  = exInfo(buyExchange).label;
  const sellLbl = exInfo(sellExchange).label;
  const labelW  = 38;

  if (!dualGeom) {
    return (
      <div style={{
        height, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, color: "var(--app-text-dimmer)", background: "rgba(0,0,0,0.12)",
        borderRadius: 6,
      }}>
        Chart loading…
      </div>
    );
  }

  const { cW, cH, zeroY, buyPts, sellPts, spreadNow, hX, lX } = dualGeom;
  const inRange = (y) => y >= PAD.t && y <= PAD.t + cH;

  return (
    <div
      style={{ position: "relative", cursor: onExpand ? "zoom-in" : "default" }}
      onClick={onExpand}
      title={onExpand ? "Click to open full chart" : undefined}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        style={{ display: "block", overflow: "hidden", borderRadius: 6 }}
      >
        {/* Background */}
        <rect x={PAD.l} y={PAD.t} width={cW} height={cH} fill="rgba(0,0,0,0.22)" rx="3" />

        {/* Zero line */}
        {inRange(zeroY) && (
          <line x1={PAD.l} y1={zeroY} x2={PAD.l + cW} y2={zeroY}
            stroke="rgba(255,255,255,0.18)" strokeWidth="1" strokeDasharray="3,4" />
        )}

        {/* ── H marker (highest spread) ── */}
        {hX != null && highSpread != null && (() => {
          const bw = labelW;
          const bx = Math.max(PAD.l, Math.min(PAD.l + cW - bw, hX - bw / 2));
          return (
            <g>
              <line x1={hX} y1={PAD.t} x2={hX} y2={PAD.t + cH}
                stroke="#22c55e" strokeWidth="0.8" strokeDasharray="2,3" opacity="0.55" />
              <rect x={bx} y={PAD.t + cH + 1} width={bw} height={13}
                fill="rgba(34,197,94,0.15)" rx="2" />
              <text x={bx + bw / 2} y={PAD.t + cH + 9.5}
                fontSize="7" fill="#22c55e" fontFamily="monospace" fontWeight="bold" textAnchor="middle">
                H {highSpread.spread >= 0 ? "+" : ""}{highSpread.spread.toFixed(3)}%
              </text>
            </g>
          );
        })()}

        {/* ── L marker (lowest spread) ── */}
        {lX != null && lowSpread != null && (() => {
          const bw = labelW;
          const bx = Math.max(PAD.l, Math.min(PAD.l + cW - bw, lX - bw / 2));
          return (
            <g>
              <line x1={lX} y1={PAD.t} x2={lX} y2={PAD.t + cH}
                stroke="#f87171" strokeWidth="0.8" strokeDasharray="2,3" opacity="0.55" />
              <rect x={bx} y={PAD.t + cH + 1} width={bw} height={13}
                fill="rgba(248,113,113,0.15)" rx="2" />
              <text x={bx + bw / 2} y={PAD.t + cH + 9.5}
                fontSize="7" fill="#f87171" fontFamily="monospace" fontWeight="bold" textAnchor="middle">
                L {lowSpread.spread >= 0 ? "+" : ""}{lowSpread.spread.toFixed(3)}%
              </text>
            </g>
          );
        })()}

        {/* Sell line — dashed */}
        {sellPts.length >= 2 && (
          <path d={mkPath(sellPts)} fill="none" stroke={sellCol}
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray="5,3"
            style={{ filter: `drop-shadow(0 0 3px ${sellCol}66)` }} />
        )}

        {/* Buy line — solid */}
        {buyPts.length >= 2 && (
          <path d={mkPath(buyPts)} fill="none" stroke={buyCol}
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ filter: `drop-shadow(0 0 3px ${buyCol}66)` }} />
        )}

        {/* Legend: Buy dot + label */}
        <circle cx={PAD.l + 5} cy={PAD.t - 5} r={3} fill={buyCol} />
        <text x={PAD.l + 11} y={PAD.t - 2} fontSize="7.5" fill={buyCol} fontFamily="monospace" fontWeight="bold">
          {buyLbl}
        </text>

        {/* Legend: Sell dashed line + label */}
        <line x1={PAD.l + 56} y1={PAD.t - 5} x2={PAD.l + 66} y2={PAD.t - 5}
          stroke={sellCol} strokeWidth="2" strokeDasharray="3,2" />
        <text x={PAD.l + 70} y={PAD.t - 2} fontSize="7.5" fill={sellCol} fontFamily="monospace" fontWeight="bold">
          {sellLbl}
        </text>

        {/* Current spread badge top-right */}
        {spreadNow != null && (() => {
          const bw = 50;
          return (
            <>
              <rect x={PAD.l + cW - bw} y={PAD.t - 12} width={bw} height={12}
                fill={spreadNow >= 0 ? "rgba(34,197,94,0.15)" : "rgba(248,113,113,0.15)"}
                rx="3" />
              <text x={PAD.l + cW - 3} y={PAD.t - 3}
                fontSize="7.5" fill={spreadNow >= 0 ? "#22c55e" : "#f87171"}
                fontFamily="monospace" fontWeight="bold" textAnchor="end">
                now {spreadNow >= 0 ? "+" : ""}{spreadNow.toFixed(3)}%
              </text>
            </>
          );
        })()}

        {/* Expand icon hint (top right, inside chart area) */}
        {onExpand && (
          <text x={PAD.l + cW - 2} y={PAD.t + 9}
            fontSize="8" fill="rgba(255,255,255,0.20)" fontFamily="monospace" textAnchor="end">
            ⛶
          </text>
        )}

        {/* Border */}
        <rect x={PAD.l} y={PAD.t} width={cW} height={cH}
          fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" rx="3" />
      </svg>
    </div>
  );
}

// ── Exchange panel — shows both BID and ASK ──────────────────────────────────

function HedgeExchangePanel({ exchange, bidPrice, askPrice, feeRate, feeTaxRate, sparkline, onChartClick, role }) {
  const { color, label } = exInfo(exchange);
  const effRate   = feeRate * (1 + feeTaxRate);
  const hasData   = sparkline && sparkline.length >= 2;
  const clickable = hasData && !!onChartClick;
  const [hovered, setHovered] = useState(false);
  const isBuy = role === "buy";

  return (
    <div
      className="flex-1 flex flex-col min-w-0"
      onClick={clickable ? onChartClick : undefined}
      onMouseEnter={() => { if (clickable) setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      style={{
        background:  "var(--app-surface-0)",
        borderRight: "1px solid var(--app-border-0)",
        cursor:      clickable ? "pointer" : "default",
        transition:  "opacity 0.15s",
        opacity:     hovered ? 0.82 : 1,
      }}
    >
      {/* BUY / SELL strip — full-width at the very top of the panel */}
      {role && (
        <div style={{
          padding: "2px 0",
          textAlign: "center",
          fontSize: 8, fontWeight: 900, letterSpacing: "0.12em",
          background: isBuy ? "rgba(34,197,94,0.13)" : "rgba(248,113,113,0.13)",
          color:      isBuy ? "var(--app-success)"   : "var(--app-danger)",
          borderBottom: `1px solid ${isBuy ? "var(--app-success-border)" : "var(--app-danger-border)"}`,
        }}>
          {isBuy ? "▲ BUY" : "▼ SELL"}
        </div>
      )}

      {/* Panel body */}
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <ExchangeIcon name={exchange} size={16} />
          <span className="text-xs font-bold truncate leading-tight" style={{ color }}>
            {label}
          </span>
          {clickable && (
            <span style={{ fontSize: 9, color, opacity: hovered ? 0.9 : 0.3, flexShrink: 0, transition: "opacity 0.15s" }}>⛶</span>
          )}
        </div>
        <span className="text-[9px] font-mono flex-shrink-0" style={{ color: "var(--app-text-muted)" }}
          title={`${fmtFeePct(feeRate)} taker${feeTaxRate > 0 ? ` + ${(feeTaxRate * 100).toFixed(0)}% tax = ${fmtFeePct(effRate)} eff` : ""}`}>
          {fmtFeePct(effRate)}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--app-danger)" }}>BID</span>
        <span className="text-xs font-extrabold font-mono tabular-nums" style={{ color: "var(--app-text-bright)" }}>
          {fmtPrice(bidPrice)}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--app-success)" }}>ASK</span>
        <span className="text-xs font-extrabold font-mono tabular-nums" style={{ color: "var(--app-text-bright)" }}>
          {fmtPrice(askPrice)}
        </span>
      </div>

      <div style={{ borderRadius: 5, overflow: "hidden" }}>
        <MiniSparkline samples={sparkline} color={color} height={28} />
      </div>
      </div>{/* end panel body */}
    </div>
  );
}

// ── Main card ────────────────────────────────────────────────────────────────

export const SpotHedgeCard = memo(function SpotHedgeCard({
  opp,
  priceMovements,           // global per-symbol movements { "4H": pct, ... }
  priceSourceMovements,     // legacy (kept for compat)
  priceSourceSparkline,
  buySparkline,
  sellSparkline,
  onChartClick,
  onCrossoverClick,
  targetedNetProfit = 0.5,
  peakMode = "spread",         // "spread" | "net"
  peakFilterEnabled = false,   // only show chips crossing targetedNetProfit
}) {
  const [crossCount, setCrossCount] = useState(0);

  const movSrc = priceMovements ?? priceSourceMovements;
  const priceMovement = useMemo(() => {
    const labels = ["4H", "8H", "12H", "24H"];
    if (!movSrc) return labels.map((label) => ({ label, pct: null }));
    return labels.map((label) => ({ label, pct: movSrc[label] ?? null }));
  }, [movSrc]);

  // ── Crossover interval peak spread + net (last 10) ────────────────────────
  const crossoverPeaks = useMemo(() => {
    if (!opp || !buySparkline?.length || !sellSparkline?.length) return [];
    const f = opp.fees ?? {};
    const totalFeePct = (f.buyFeeRate ?? 0.001) * (1 + (f.feeTaxRate ?? 0)) * 100
                      + (f.sellFeeRate ?? 0.001) * (1 + (f.feeTaxRate ?? 0)) * 100
                      + (f.tdsRate ?? 0.01) * 100;
    const aligned = buySparkline
      .filter((b) => isFinite(b.price) && isFinite(b.ts))
      .map((b) => {
        const s = binaryNearest(sellSparkline, b.ts);
        return s?.price ? { ts: b.ts, ask: b.price, bid: s.price } : null;
      })
      .filter(Boolean);
    if (aligned.length < 2) return [];
    const crossingTs = [];
    for (let i = 0; i < aligned.length - 1; i++) {
      const cs = aligned[i].bid - aligned[i].ask;
      const ns = aligned[i + 1].bid - aligned[i + 1].ask;
      if ((cs >= 0) !== (ns >= 0)) {
        const t = -cs / (ns - cs);
        crossingTs.push(aligned[i].ts + t * (aligned[i + 1].ts - aligned[i].ts));
      }
    }
    if (!crossingTs.length) return [];
    const bounds = [aligned[0].ts, ...crossingTs, aligned[aligned.length - 1].ts];
    const intervals = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const tS = bounds[i], tE = bounds[i + 1];
      const crossTs = i > 0 ? bounds[i] : null;
      const isCurrent = i === bounds.length - 2;
      let maxSpread = null, minSpread = null;
      let maxNet = null,    minNet = null;
      for (const p of aligned) {
        if (p.ts < tS || p.ts > tE) continue;
        const spread = ((p.bid - p.ask) / p.ask) * 100;
        const net    = spread - totalFeePct;
        if (maxSpread === null || spread > maxSpread) maxSpread = spread;
        if (minSpread === null || spread < minSpread) minSpread = spread;
        if (maxNet    === null || net    > maxNet)    maxNet    = net;
        if (minNet    === null || net    < minNet)    minNet    = net;
      }
      if (maxSpread !== null) intervals.push({ maxSpread, minSpread, maxNet, minNet, crossTs, isCurrent });
    }
    return intervals.slice(-5).reverse();
  }, [opp, buySparkline, sellSparkline]);

  // ── MUST be before early return — Rules of Hooks ───────────────────────────
  // highest/lowest depend on crossoverPeaks (above) and opp props.
  // If placed after `if (!opp) return null`, React throws "Invalid hook call".
  const highest = useMemo(() => {
    if (!opp) return null;
    if (!peakFilterEnabled || crossoverPeaks.length === 0) return opp.highestNetProfitPct;
    const qualifying = crossoverPeaks.filter(({ maxNet }) => maxNet != null && Math.abs(maxNet) >= targetedNetProfit);
    if (qualifying.length === 0) return null;
    const vals = qualifying.map(({ maxNet }) => maxNet).filter((v) => v != null && v > 0);
    return vals.length > 0 ? Math.max(...vals) : null;
  }, [opp, peakFilterEnabled, crossoverPeaks, targetedNetProfit]);

  const lowest = useMemo(() => {
    if (!opp) return null;
    if (!peakFilterEnabled || crossoverPeaks.length === 0) return opp.lowestNetProfitPct;
    const qualifying = crossoverPeaks.filter(({ maxNet }) => maxNet != null && Math.abs(maxNet) >= targetedNetProfit);
    if (qualifying.length === 0) return null;
    const vals = qualifying.map(({ maxNet }) => maxNet).filter((v) => v != null && v < 0);
    return vals.length > 0 ? Math.min(...vals) : null;
  }, [opp, peakFilterEnabled, crossoverPeaks, targetedNetProfit]);

  if (!opp) return null;

  const fees = opp.fees ?? {};

  // Live net profit = Spread% - Fees% - TDS%
  const spreadNet = computeSpreadNetPct(opp);
  const nc = netColor(spreadNet);

  const priceMap = {};
  (opp.allPrices ?? []).forEach((p) => { priceMap[p.exchange] = p; });

  const buyPrices  = priceMap[opp.buyExchange]  ?? { bid: null, ask: opp.buyAsk };
  const sellPrices = priceMap[opp.sellExchange] ?? { bid: opp.sellBid, ask: null };

  return (
    <div
      className="rounded-xl overflow-hidden flex flex-col"
      style={{ background: "var(--app-surface-0)", border: "1px solid var(--app-border-0)" }}
    >
      {/* ── Header ── */}
      <div
        className="flex items-center justify-between px-4 py-2.5 gap-3 overflow-hidden"
        style={{ background: "var(--app-surface-1)", borderBottom: "1px solid var(--app-border-0)" }}
      >
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          <div className="flex-shrink-0"><CoinIcon symbol={opp.symbol} size={20} /></div>
          <span className="text-sm font-extrabold tracking-wide uppercase truncate" style={{ color: "var(--app-text-bright)" }}>
            {opp.symbol}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Spread — signed, colored */}
          {(() => {
            const sp = opp.priceDiffPct;
            const spPos = sp == null || sp >= 0;
            return (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold whitespace-nowrap"
                title="Raw price spread (sellBid − buyAsk) / buyAsk × 100"
                style={{
                  color:      spPos ? "var(--app-text-muted)" : "var(--app-danger)",
                  background: spPos ? "rgba(148,163,184,0.08)" : "rgba(248,113,113,0.08)",
                }}>
                {fmtPct(sp, true)}
              </span>
            );
          })()}
          {/* Live Net = Spread − Fees − TDS */}
          <span
            className="px-2 py-0.5 rounded-full text-xs font-bold font-mono whitespace-nowrap"
            title={`Net % = Spread − Taker Fees (incl. tax) − TDS`}
            style={{
              background: spreadNet != null && spreadNet >= 0 ? "var(--app-success-soft)" : "var(--app-danger-soft)",
              color: nc,
              border: `1px solid ${spreadNet != null && spreadNet >= 0 ? "var(--app-success-border)" : "var(--app-danger-border)"}`,
            }}
          >
            {fmtPct(spreadNet, true)}
          </span>
        </div>
      </div>

      {/* ── Exchange panels ── */}
      <div className="flex" style={{ borderBottom: "1px solid var(--app-border-0)" }}>
        <HedgeExchangePanel
          exchange={opp.buyExchange}
          bidPrice={buyPrices.bid}
          askPrice={buyPrices.ask}
          feeRate={fees.buyFeeRate ?? 0.001}
          feeTaxRate={fees.feeTaxRate ?? 0}
          sparkline={buySparkline ?? priceSourceSparkline}
          onChartClick={onChartClick}
          role="buy"
        />
        <HedgeExchangePanel
          exchange={opp.sellExchange}
          bidPrice={sellPrices.bid}
          askPrice={sellPrices.ask}
          feeRate={fees.sellFeeRate ?? 0.001}
          feeTaxRate={fees.feeTaxRate ?? 0}
          sparkline={sellSparkline ?? priceSourceSparkline}
          onChartClick={onChartClick}
          role="sell"
        />
      </div>


      {/* ── Net Profit Stats ── */}
      <div className="px-3 pt-2 pb-2 flex flex-col gap-1.5"
        style={{ borderBottom: "1px solid var(--app-border-0)", background: "var(--app-surface-1)" }}>
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
          Net Profit Stats (4H)
        </span>
        <div className="grid grid-cols-3 gap-2">
          {/* Peak High — sabse jyada positive net profit (only show if > 0) */}
          <div className="flex flex-col">
            <span className="text-sm font-bold font-mono leading-tight"
              style={{ color: highest != null && highest > 0 ? "var(--app-success)" : "var(--app-text-dim)" }}>
              {highest != null && highest > 0 ? `+${highest.toFixed(3)}%` : "—"}
            </span>
            <span className="text-[9px] uppercase tracking-wide font-medium leading-tight mt-0.5"
              style={{ color: "var(--app-text-dim)" }}>Peak High</span>
          </div>
          {/* Peak Low — sabse jyada negative net profit (only show if < 0) */}
          <div className="flex flex-col">
            <span className="text-sm font-bold font-mono leading-tight"
              style={{ color: lowest != null && lowest < 0 ? "var(--app-danger)" : "var(--app-text-dim)" }}>
              {lowest != null && lowest < 0 ? `${lowest.toFixed(3)}%` : "—"}
            </span>
            <span className="text-[9px] uppercase tracking-wide font-medium leading-tight mt-0.5"
              style={{ color: "var(--app-text-dim)" }}>Peak Low</span>
          </div>
          {/* Target */}
          <div className="flex flex-col">
            <span className="text-sm font-bold font-mono leading-tight" style={{ color: "var(--app-text-muted)" }}>
              {fmtPct(targetedNetProfit, false)}
            </span>
            <span className="text-[9px] uppercase tracking-wide font-medium leading-tight mt-0.5"
              style={{ color: "var(--app-text-dim)" }}>Target</span>
          </div>
        </div>
      </div>

      {/* ── Price Movement (mark price) ── */}
      <div className="px-3 pt-2 pb-2"
        style={{ borderBottom: "1px solid var(--app-border-0)", background: "var(--app-surface-1)" }}>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
            Price Movement
          </span>
          <span className="text-[8px]" style={{ color: "var(--app-text-dimmer)" }}>mark price</span>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {priceMovement.map(({ label, pct }) => {
            const pctColor = pct == null
              ? "var(--app-text-dimmer)"
              : pct >= 0 ? "var(--app-success)" : "var(--app-danger)";
            return (
              <div key={label} className="flex flex-col items-center rounded-md py-1"
                style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-0)" }}>
                <span className="text-[8px] font-bold uppercase tracking-wider"
                  style={{ color: "var(--app-text-dim)" }}>{label}</span>
                <span className="text-[10px] font-bold font-mono tabular-nums leading-tight" style={{ color: pctColor }}>
                  {pct == null ? "—" : fmtPct(pct, true)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Price Crossover Chart (absolute ask vs bid) ── */}
      <div className="px-3 pt-2 pb-1.5" style={{ borderBottom: "1px solid var(--app-border-0)", background: "var(--app-surface-1)" }}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
            Price Crossover
          </span>
          {crossCount > 0 && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 3,
              padding: "1px 5px 1px 4px", borderRadius: 5,
              background: "rgba(139,92,246,0.10)",
              border: "1px solid rgba(139,92,246,0.28)",
            }}>
              <span style={{
                display: "inline-block", width: 4, height: 4, borderRadius: "50%",
                background: "#a78bfa",
                animation: "crossPulse 1.4s ease-in-out infinite",
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 8, fontWeight: 700, fontFamily: "monospace", color: "#a78bfa", letterSpacing: "0.02em" }}>
                {crossCount}✕
              </span>
            </span>
          )}
        </div>
        <InlineAbsPriceChart
          buyData={buySparkline}
          sellData={sellSparkline}
          buyExchange={opp.buyExchange}
          sellExchange={opp.sellExchange}
          height={68}
          onExpand={onCrossoverClick ?? onChartClick}
          onCrossings={setCrossCount}
        />

        {/* Peak spread / net per crossover interval — last 10, optionally filtered */}
        {(() => {
          if (crossoverPeaks.length === 0) return null;

          // crossoverPeaks is most-recent-first; reverse to get chronological (oldest = C1)
          const chron = [...crossoverPeaks].reverse();

          // Tag with direction-aware displayVal
          //   positive interval (maxSpread > 0) → displayVal = maxNet (peak profit)
          //   negative interval (maxSpread <= 0) → displayVal = minNet (deepest loss)
          const taggedChron = chron.map((p) => {
            const isPos = p.maxSpread != null && p.maxSpread > 0;
            const displayVal = peakMode === "net"
              ? (isPos ? p.maxNet : p.minNet)
              : (isPos ? p.maxSpread : p.minSpread);
            return { ...p, displayVal };
          });

          let visiblePeaks;

          if (peakFilterEnabled) {
            // Keep only intervals that crossed ±targetedNetProfit
            const qualifying = taggedChron.filter(({ displayVal }) =>
              displayVal != null &&
              (displayVal >= targetedNetProfit || displayVal <= -targetedNetProfit)
            );

            if (qualifying.length === 0) {
              // Fallback: show best pos + best neg dimmed so section isn't empty
              const anyPos = taggedChron
                .filter(({ displayVal }) => displayVal != null && displayVal > 0)
                .sort((a, b) => b.displayVal - a.displayVal)[0];
              const anyNeg = taggedChron
                .filter(({ displayVal }) => displayVal != null && displayVal < 0)
                .sort((a, b) => a.displayVal - b.displayVal)[0];
              visiblePeaks = [anyPos, anyNeg]
                .filter(Boolean)
                .map((p, i) => ({ ...p, chunkIdx: i + 1, timeBetween: null, belowTarget: true }));
            } else {
              // Strictly alternating: C1(-) → C2(+) → C3(-) …
              // If multiple consecutive same-direction chips qualify, skip all but the first
              // before direction changes. Time shown = from PREVIOUS kept chip to this chip.
              const alternating = [];
              for (const p of qualifying) {
                const pPos = p.displayVal > 0;
                if (alternating.length === 0) {
                  alternating.push(p);
                } else {
                  const lastPos = alternating[alternating.length - 1].displayVal > 0;
                  if (pPos !== lastPos) alternating.push(p); // direction changed → keep
                  // same direction → skip
                }
              }
              visiblePeaks = alternating.map((p, i) => {
                const prevTs = i > 0 ? alternating[i - 1].crossTs : null;
                const timeBetween = prevTs != null && p.crossTs != null
                  ? p.crossTs - prevTs : null;
                return { ...p, chunkIdx: i + 1, timeBetween };
              });
            }
          } else {
            // Filter OFF: all chips in chronological order (C1 = oldest)
            visiblePeaks = taggedChron.map((p, i) => ({
              ...p, chunkIdx: i + 1, timeBetween: null,
            }));
          }

          if (visiblePeaks.length === 0) return null;

          const hitCount = taggedChron.filter(({ displayVal }) =>
            displayVal != null &&
            (displayVal >= targetedNetProfit || displayVal <= -targetedNetProfit)
          ).length;

          return (
            <div className="mt-1.5">
              {peakFilterEnabled && (
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                    {hitCount}/{crossoverPeaks.length} crossed target
                  </span>
                </div>
              )}
              <div className="flex flex-nowrap gap-0.5 overflow-hidden">
                {[...visiblePeaks].reverse().map(({ displayVal, crossTs, isCurrent, chunkIdx, timeBetween, belowTarget }) => {
                  const val      = displayVal;
                  const pos      = val != null && val > 0;
                  const timeAgo  = fmtCrossTime(crossTs);       // how long ago this crossing
                  const duration = fmtDuration(timeBetween);    // time from prev chip to this chip
                  return (
                    <div key={chunkIdx}
                      className="flex flex-col items-center px-1.5 py-0.5 rounded"
                      title={`C${chunkIdx}: peak net profit in this crossover interval${crossTs ? ` · crossed ${timeAgo} ago` : ""}${isCurrent ? " · current interval" : ""}${belowTarget ? " · below target" : ""}`}
                      style={{
                        background: pos ? "rgba(34,197,94,0.08)" : "rgba(248,113,113,0.08)",
                        border: `1px solid ${pos ? "var(--app-success-border)" : "var(--app-danger-border)"}`,
                        position: "relative",
                        opacity: belowTarget ? 0.45 : 1,
                      }}>
                      {isCurrent && (
                        <span style={{
                          position: "absolute", top: -3, right: -3,
                          width: 5, height: 5, borderRadius: "50%",
                          background: "var(--app-success)",
                          animation: "crossPulse 1.4s ease-in-out infinite",
                        }} />
                      )}
                      <span className="text-[9px] font-bold font-mono leading-tight"
                        style={{ color: pos ? "var(--app-success)" : "var(--app-danger)" }}>
                        {val == null ? "—" : `${val >= 0 ? "+" : ""}${val.toFixed(3)}%`}
                      </span>
                      <span className="text-[7px] font-medium leading-none mt-0.5"
                        style={{ color: "var(--app-text-dimmer)" }}>
                        {/* C-number | duration from previous chip (C2+) | timeAgo for C1 */}
                        C{chunkIdx}{duration ? ` · ${duration}` : (chunkIdx === 1 && timeAgo ? ` · ${timeAgo}` : "")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>{/* end crossover section */}

      {/* ── Inline Dual-Price Spread Chart ── */}
      <div className="px-3 pt-2 pb-2.5" style={{ background: "var(--app-surface-1)" }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-muted)" }}>
            Spread Chart
          </span>
          <span className="text-[8px]" style={{ color: "var(--app-text-dimmer)" }}>BUY ask · SELL bid</span>
        </div>
        <InlineDualChart
          buyData={buySparkline}
          sellData={sellSparkline}
          buyExchange={opp.buyExchange}
          sellExchange={opp.sellExchange}
          height={80}
          onExpand={onChartClick}
        />
      </div>
    </div>
  );
});
