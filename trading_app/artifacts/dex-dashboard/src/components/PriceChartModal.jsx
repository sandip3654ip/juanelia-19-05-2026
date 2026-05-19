import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { X } from "lucide-react";
import { CoinIcon }         from "@/components/CoinIcon";
import { ExchangeIcon }     from "@/components/ExchangeIcon";
import { loadSpotDefaults } from "@/lib/spotDefaults";

// ── Exchange brand colours ─────────────────────────────────────────────────
const EX_COLORS = {
  binance: "#F3BA2F",
  bybit:   "#FFC200",
  kucoin:  "#0DBB6F",
  bitget:  "#00C6FF",
};
function exColor(n) { return EX_COLORS[n] ?? "#94a3b8"; }
function exLabel(n) { return n ? n.charAt(0).toUpperCase() + n.slice(1) : ""; }

// ── Formatters ─────────────────────────────────────────────────────────────
function fmtPrice(v) {
  if (v == null || !isFinite(v)) return "—";
  if (v >= 10_000) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (v >= 1_000)  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1)      return v.toFixed(4);
  if (v >= 0.01)   return v.toFixed(5);
  if (v >= 0.0001) return v.toFixed(6);
  return v.toPrecision(4);
}
function fmtAxis(v, range) {
  if (v == null || !isFinite(v)) return "";
  if (range >= 1000)  return v.toFixed(0);
  if (range >= 10)    return v.toFixed(1);
  if (range >= 1)     return v.toFixed(2);
  if (range >= 0.1)   return v.toFixed(3);
  if (range >= 0.001) return v.toFixed(5);
  return v.toPrecision(4);
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtTooltipTs(ts) {
  return new Date(ts).toLocaleString([], {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}
function pctChange(data) {
  if (!data || data.length < 2) return null;
  const f = data[0].price, l = data[data.length - 1].price;
  return f ? ((l - f) / f) * 100 : null;
}

// ── Filter data by range with anchor timestamp ─────────────────────────────
// anchorTs = the "right edge" of the visible window (default = now).
// Allows panning: anchorTs = now - panDeltaMs.
function filterByRange(data, hours, anchorTs) {
  if (!data?.length) return [];
  const startTs = anchorTs - hours * 3_600_000;
  const result  = data.filter((d) => d.ts >= startTs && d.ts <= anchorTs);
  return result.length >= 2 ? result : [];
}

// ── Binary search for nearest point (O(log n), assumes data sorted by ts) ──
function binaryNearest(data, ts) {
  if (!data || !data.length) return null;
  let lo = 0, hi = data.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return data[0];
  if (lo >= data.length) return data[data.length - 1];
  const before = data[lo - 1], after = data[lo];
  return Math.abs(before.ts - ts) <= Math.abs(after.ts - ts) ? before : after;
}

// ── Build spread series (O(n log n) with binary search) ────────────────────
function buildSpread(buyData, sellData) {
  if (!buyData?.length || !sellData?.length) return [];
  return buyData.map((b) => {
    const s = binaryNearest(sellData, b.ts);
    if (!s || !b.price || !s.price) return null;
    return { ts: b.ts, spread: ((s.price - b.price) / b.price) * 100 };
  }).filter(Boolean);
}

// ── Gap-aware smooth SVG path — Catmull-Rom → Cubic Bézier ───────────────
// gapPx: pixel width that counts as a "data gap" → line breaks, no drawing.
// Catmull-Rom control points are clamped to not cross gap boundaries.
function mkSmoothLine(pts, gapPx = Infinity) {
  if (!pts || pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  let gapBefore = false;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    if (dx > gapPx) {
      // Break: move to next segment without drawing a line
      d += ` M${pts[i + 1][0].toFixed(2)},${pts[i + 1][1].toFixed(2)}`;
      gapBefore = true;
      continue;
    }
    // Don't borrow p0 or p3 from across a gap boundary
    const gapAfter = i + 2 < pts.length && pts[i + 2][0] - pts[i + 1][0] > gapPx;
    const p0 = gapBefore ? pts[i] : pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = gapAfter  ? pts[i + 1] : pts[Math.min(pts.length - 1, i + 2)];
    gapBefore = false;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

// Split pts array into continuous segments separated by gaps.
function mkSegments(pts, gapPx) {
  const segs = [];
  let seg = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] - pts[i - 1][0] > gapPx) {
      if (seg.length >= 2) segs.push(seg);
      seg = [pts[i]];
    } else {
      seg.push(pts[i]);
    }
  }
  if (seg.length >= 2) segs.push(seg);
  return segs;
}

// Area fill: one closed polygon per continuous segment (no fill across gaps).
function mkSmoothArea(pts, baseY, gapPx = Infinity) {
  if (!pts || pts.length < 2) return "";
  return mkSegments(pts, gapPx).map((s) => {
    const n = s.length;
    return `${mkSmoothLine(s)} L${s[n-1][0].toFixed(2)},${baseY} L${s[0][0].toFixed(2)},${baseY} Z`;
  }).join(" ");
}

// ── Chart layout constants ─────────────────────────────────────────────────
const PAD  = { top: 16, right: 76, bottom: 28, left: 10 };
const SPAD = { top: 6,  right: 76, bottom: 20, left: 10 };

// ── PriceChart (pure SVG canvas) ───────────────────────────────────────────
function PriceChart({ series, subData, subLabel, subColor, subIsProfit, onCursor, onPanDelta, isPanned }) {
  const svgRef   = useRef(null);
  const [sz, setSz] = useState({ w: 840, h: 450 });
  const [cursor, setCursor]   = useState(null);
  const [grabbing, setGrabbing] = useState(false);

  // Drag-to-pan: use refs so mousemove never re-creates handlers
  const isDragging  = useRef(false);
  const dragLastX   = useRef(0);
  const hasDragged  = useRef(false);
  const rafPending  = useRef(null);
  const pendingDeltaMs = useRef(0);

  useEffect(() => {
    if (!svgRef.current) return;
    const ro = new ResizeObserver(([e]) =>
      setSz({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    ro.observe(svgRef.current);
    return () => ro.disconnect();
  }, []);

  const { w, h } = sz;
  const MAIN_H  = Math.floor(h * 0.68);
  const SPRD_H  = h - MAIN_H;
  const chartW  = Math.max(10, w - PAD.left  - PAD.right);
  const chartH  = Math.max(10, MAIN_H - PAD.top  - PAD.bottom);
  const sChartH = Math.max(10, SPRD_H - SPAD.top - SPAD.bottom);

  // ── price range ──────────────────────────────────────────────────────────
  // Memoized: only recomputes when `series` prop ref changes (stable from parent).
  // Avoids O(n) flatMap + Math.min/max spread on every cursor-move re-render.
  const { allP, allT, noData, minTs, maxTs } = useMemo(() => {
    const prices = [], times = [];
    for (const s of series) {
      for (const d of (s.data || [])) {
        if (isFinite(d.price)) prices.push(d.price);
        if (isFinite(d.ts))    times.push(d.ts);
      }
    }
    if (!prices.length || !times.length) {
      return { allP: [], allT: [], noData: true, minTs: 0, maxTs: 1 };
    }
    let mn = times[0], mx = times[0];
    for (let i = 1; i < times.length; i++) {
      if (times[i] < mn) mn = times[i];
      if (times[i] > mx) mx = times[i];
    }
    return { allP: prices, allT: times, noData: false, minTs: mn, maxTs: mx };
  }, [series]);

  const msPerPx = ((maxTs - minTs) || 3_600_000) / (chartW || 1);

  // ── mouse helpers (must be before early return — Rules of Hooks) ───────────
  function clientToSvg(clientX, clientY) {
    if (!svgRef.current) return { mx: 0, my: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    return {
      mx: (clientX - rect.left) / rect.width  * w,
      my: (clientY - rect.top)  / rect.height * h,
    };
  }

  function schedulePan(deltaMs) {
    pendingDeltaMs.current += deltaMs;
    if (rafPending.current) return;
    rafPending.current = requestAnimationFrame(() => {
      onPanDelta(pendingDeltaMs.current);
      pendingDeltaMs.current = 0;
      rafPending.current = null;
    });
  }

  // ── event handlers — ALL useCallback MUST be before the early return ───────
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const { mx } = clientToSvg(e.clientX, e.clientY);
    isDragging.current  = true;
    hasDragged.current  = false;
    dragLastX.current   = mx;
    setGrabbing(true);
    e.preventDefault();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h]);

  const handleMM = useCallback((e) => {
    const { mx, my } = clientToSvg(e.clientX, e.clientY);

    if (isDragging.current) {
      const dx = mx - dragLastX.current;
      if (Math.abs(dx) > 1) hasDragged.current = true;
      dragLastX.current = mx;
      if (Math.abs(dx) > 0.3) schedulePan(-dx * msPerPx);
      setCursor(null);
      onCursor(null);
      return;
    }

    if (mx < PAD.left || mx > PAD.left + chartW + 8) {
      setCursor(null); onCursor(null); return;
    }
    void my;
    const mxC      = Math.min(mx, PAD.left + chartW);
    const tsCursor = minTs + ((mxC - PAD.left) / chartW) * (maxTs - minTs);

    const vals = series.map((s) => {
      const pt = binaryNearest(s.data, tsCursor);
      return { exchange: s.exchange, color: s.color, price: pt?.price ?? null, ts: pt?.ts ?? null };
    });

    let subTsCursor = tsCursor;
    if (subIsProfit && subData?.length) {
      // Loop instead of spread — avoids call-stack pressure for large profit arrays
      let sMin = Infinity, sMax = -Infinity;
      for (const d of subData) {
        if (!isFinite(d.ts)) continue;
        if (d.ts < sMin) sMin = d.ts;
        if (d.ts > sMax) sMax = d.ts;
      }
      if (sMin !== Infinity) {
        subTsCursor = sMin + ((mxC - SPAD.left) / chartW) * ((sMax - sMin) || 1);
      }
    }
    const sprd = binaryNearest(subData || [], subTsCursor);
    const cur  = { mx: mxC, ts: tsCursor, vals, subValue: sprd?.value ?? null, subTs: sprd?.ts ?? null };
    setCursor(cur);
    onCursor(cur);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, subData, subIsProfit, minTs, maxTs, chartW, msPerPx, w, h, onCursor]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    setGrabbing(false);
  }, []);

  const handleML = useCallback(() => {
    isDragging.current = false;
    setGrabbing(false);
    setCursor(null);
    onCursor(null);
  }, [onCursor]);

  // ── Scale + point arrays — ONE useMemo before early return ──────────────────
  // All hooks must come before conditional returns (Rules of Hooks).
  // This memo handles the empty case (noData=true) by returning null sentinels.
  // Recomputes only when data, chart dimensions, or sub-chart mode changes —
  // NOT on cursor moves or pan (those only change anchorTs → buyData/sellData deps).
  const renderData = useMemo(() => {
    if (noData) return null;

    // ── Price scale ─────────────────────────────────────────────────────────
    let pMn = Infinity, pMx = -Infinity;
    for (const p of allP) { if (p < pMn) pMn = p; if (p > pMx) pMx = p; }
    const rngP = (pMx - pMn) || Math.abs(pMx) * 0.005 || 1;
    const padP = rngP * 0.14;
    const p0 = pMn - padP, p1 = pMx + padP;
    const xOf = (ts) => PAD.left + ((ts - minTs) / ((maxTs - minTs) || 1)) * chartW;
    const yOf = (p)  => PAD.top  + (1 - (p - p0) / (p1 - p0)) * chartH;

    // ── Sub-chart scale ──────────────────────────────────────────────────────
    let sMn = Infinity, sMx = -Infinity, tMin = minTs, tMax = maxTs;
    for (const d of (subData || [])) {
      if (!isFinite(d.value)) continue;
      if (d.value < sMn) sMn = d.value;
      if (d.value > sMx) sMx = d.value;
      if (subIsProfit && isFinite(d.ts)) {
        if (d.ts < tMin) tMin = d.ts;
        if (d.ts > tMax) tMax = d.ts;
      }
    }
    if (!isFinite(sMn)) { sMn = -0.5; sMx = 0.5; }
    const rngS = (sMx - sMn) || 0.1;
    const padS = rngS * 0.2;
    const s0 = sMn - padS, s1 = sMx + padS;
    const syOf  = (v) => MAIN_H + SPAD.top + (1 - (v - s0) / (s1 - s0)) * sChartH;
    const subXOf = subIsProfit
      ? (ts) => SPAD.left + ((ts - tMin) / ((tMax - tMin) || 1)) * chartW
      : xOf;
    const zeroY  = syOf(0);
    const zeroPct = Math.max(0, Math.min(1, s1 / (s1 - s0)));

    // ── Pixel point arrays ───────────────────────────────────────────────────
    const seriesPts = series.map((s) => ({
      ...s,
      pts: (s.data || [])
        .filter((d) => isFinite(d.price) && isFinite(d.ts))
        .map((d) => [xOf(d.ts), yOf(d.price)]),
    }));
    const spreadPts = (subData || [])
      .filter((d) => isFinite(d.value) && isFinite(d.ts))
      .map((d) => [subXOf(d.ts), syOf(d.value)]);

    // ── High / Low markers ───────────────────────────────────────────────────
    let hi = null, lo = null;
    for (const s of series) {
      for (const d of (s.data || [])) {
        if (!isFinite(d.price)) continue;
        if (!hi || d.price > hi.price) hi = d;
        if (!lo || d.price < lo.price) lo = d;
      }
    }

    return {
      p0, p1, rangeP: rngP, minP: pMn, maxP: pMx,
      s0, s1, zeroY, zeroPct,
      subMinTs: tMin, subMaxTs: tMax,
      xOf, yOf, syOf, subXOf,
      seriesPts, spreadPts,
      highD: hi, lowD: lo,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noData, allP, series, subData, subIsProfit, minTs, maxTs, chartW, chartH, sChartH, MAIN_H]);

  // ── Early return AFTER all hooks ──────────────────────────────────────────
  if (noData || !renderData) {
    return (
      <div ref={svgRef} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "#334155", fontSize: 12 }}>No price data for selected range</span>
      </div>
    );
  }

  const { p0, p1, rangeP, s0, s1, zeroY, zeroPct, subMinTs, subMaxTs, xOf, yOf, syOf, subXOf, seriesPts, spreadPts, highD, lowD } = renderData;

  // ── grid ticks ───────────────────────────────────────────────────────────
  const yTicks = Array.from({ length: 5 }, (_, i) => p0 + (i / 4) * (p1 - p0));
  const xTicks = Array.from({ length: 6 }, (_, i) => minTs + (i / 5) * (maxTs - minTs));

  // ── sub-chart axis range (for spread/profit labels) ───────────────────────
  const allSprd   = spreadPts; // alias — used for length check in JSX labels
  const subValues = (subData || []).map((d) => d.value).filter(isFinite);
  const minSprd   = subValues.length ? Math.min(...subValues) : 0;
  const maxSprd   = subValues.length ? Math.max(...subValues) : 0;
  const rangeSprd = (maxSprd - minSprd) || 0.1;

  // ── crosshair snap ────────────────────────────────────────────────────────
  const snapTs = cursor?.vals?.[0]?.ts;
  const snapX  = snapTs != null ? xOf(snapTs) : cursor?.mx;

  return (
    <div ref={svgRef} style={{ flex: 1, position: "relative", minHeight: 0 }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height="100%"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMM}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleML}
        style={{
          display: "block",
          cursor: grabbing ? "grabbing" : isPanned ? "grab" : "crosshair",
          userSelect: "none",
        }}
      >
        <defs>
          <clipPath id="pcm-main">
            <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH} />
          </clipPath>
          <clipPath id="pcm-sprd">
            <rect x={SPAD.left} y={MAIN_H + SPAD.top} width={chartW} height={sChartH} />
          </clipPath>
          {series.map((s) => (
            <linearGradient key={`g-${s.exchange}`} id={`g-${s.exchange}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={s.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.01" />
            </linearGradient>
          ))}
          {subIsProfit ? (
            <linearGradient id="g-sprd" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"                                stopColor="#22c55e" stopOpacity="0.32" />
              <stop offset={`${(zeroPct * 100).toFixed(1)}%`} stopColor="#22c55e" stopOpacity="0.10" />
              <stop offset={`${(zeroPct * 100).toFixed(1)}%`} stopColor="#f87171" stopOpacity="0.10" />
              <stop offset="100%"                              stopColor="#f87171" stopOpacity="0.32" />
            </linearGradient>
          ) : (
            <linearGradient id="g-sprd" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={subColor} stopOpacity="0.30" />
              <stop offset="100%" stopColor={subColor} stopOpacity="0.01" />
            </linearGradient>
          )}
        </defs>

        {/* ── MAIN CHART bg ── */}
        <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH} fill="rgba(0,0,0,0.22)" />

        {/* Y grid + right-axis labels */}
        {yTicks.map((p, i) => {
          const y = yOf(p);
          return (
            <g key={`yg${i}`}>
              <line x1={PAD.left} y1={y} x2={PAD.left + chartW} y2={y}
                stroke="rgba(255,255,255,0.06)" strokeWidth="1"
                strokeDasharray={i === 0 || i === 4 ? "0" : "3,5"} />
              <text x={PAD.left + chartW + 5} y={y + 3.5}
                fontSize="9" fill="#3d4f66" fontFamily="monospace" textAnchor="start">
                {fmtAxis(p, rangeP)}
              </text>
            </g>
          );
        })}

        {/* X grid + time labels */}
        {xTicks.map((ts, i) => {
          const x = xOf(ts);
          return (
            <g key={`xt${i}`}>
              <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + chartH}
                stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="3,5" />
              <text x={x} y={PAD.top + chartH + 12}
                fontSize="8.5" fill="#3d4f66" fontFamily="monospace" textAnchor="middle">
                {fmtTime(ts)}
              </text>
            </g>
          );
        })}

        {/* Border */}
        <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH}
          fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="1" />

        {/* ── Series: smooth area + smooth line ── */}
        {seriesPts.map((s, si) => (
          <g key={s.exchange} clipPath="url(#pcm-main)">
            <path d={mkSmoothArea(s.pts, PAD.top + chartH)} fill={`url(#g-${s.exchange})`} />
            <path d={mkSmoothLine(s.pts)}
              stroke={s.color}
              strokeWidth={si === 0 ? 2.2 : 1.8}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={si === 1 ? "7,3" : "none"}
              style={{ filter: `drop-shadow(0 0 4px ${s.color}55)` }} />
          </g>
        ))}

        {/* High marker */}
        {highD && (() => {
          const x = xOf(highD.ts), y = yOf(highD.price);
          const goRight = x < PAD.left + chartW * 0.8;
          return (
            <g clipPath="url(#pcm-main)">
              <line x1={x} y1={y} x2={x} y2={PAD.top + chartH}
                stroke="#22c55e" strokeWidth="0.8" strokeDasharray="2,3" opacity="0.4" />
              <circle cx={x} cy={y} r={4.5} fill="#22c55e" opacity="0.9"
                style={{ filter: "drop-shadow(0 0 4px #22c55e88)" }} />
              <rect x={goRight ? x + 6 : x - 56} y={y - 10} width={50} height={14}
                fill="rgba(0,0,0,0.55)" rx="3" />
              <text x={goRight ? x + 31 : x - 31} y={y + 0.5}
                fontSize="8.5" fill="#4ade80" fontFamily="monospace" fontWeight="bold" textAnchor="middle">
                H {fmtAxis(highD.price, rangeP)}
              </text>
            </g>
          );
        })()}

        {/* Low marker */}
        {lowD && (() => {
          const x = xOf(lowD.ts), y = yOf(lowD.price);
          const goRight = x < PAD.left + chartW * 0.8;
          return (
            <g clipPath="url(#pcm-main)">
              <line x1={x} y1={PAD.top} x2={x} y2={y}
                stroke="#f87171" strokeWidth="0.8" strokeDasharray="2,3" opacity="0.4" />
              <circle cx={x} cy={y} r={4.5} fill="#f87171" opacity="0.9"
                style={{ filter: "drop-shadow(0 0 4px #f8717188)" }} />
              <rect x={goRight ? x + 6 : x - 56} y={y - 3} width={50} height={14}
                fill="rgba(0,0,0,0.55)" rx="3" />
              <text x={goRight ? x + 31 : x - 31} y={y + 8}
                fontSize="8.5" fill="#f87171" fontFamily="monospace" fontWeight="bold" textAnchor="middle">
                L {fmtAxis(lowD.price, rangeP)}
              </text>
            </g>
          );
        })()}

        {/* ── SPREAD / PROFIT sub-chart ── */}
        <rect x={SPAD.left} y={MAIN_H + SPAD.top} width={chartW} height={sChartH}
          fill="rgba(0,0,0,0.20)" />

        {/* Zero line */}
        {isFinite(zeroY) && zeroY >= MAIN_H + SPAD.top && zeroY <= MAIN_H + SPAD.top + sChartH && (
          <line x1={SPAD.left} y1={zeroY} x2={SPAD.left + chartW} y2={zeroY}
            stroke="rgba(255,255,255,0.20)" strokeWidth="1" strokeDasharray="4,4" />
        )}

        {/* Sub-chart smooth area + line */}
        {spreadPts.length >= 2 && (
          <g clipPath="url(#pcm-sprd)">
            <path d={mkSmoothArea(spreadPts, MAIN_H + SPAD.top + sChartH)} fill="url(#g-sprd)" />
            <path d={mkSmoothLine(spreadPts)}
              stroke={subColor} strokeWidth="1.6" fill="none"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ filter: `drop-shadow(0 0 3px ${subColor}55)` }} />
          </g>
        )}

        {/* Sub-chart axis labels */}
        <text x={SPAD.left + chartW + 5} y={MAIN_H + SPAD.top + 10}
          fontSize="8" fill="#3d5040" fontFamily="monospace">
          {allSprd.length ? `${maxSprd >= 0 ? "+" : ""}${fmtAxis(maxSprd, rangeSprd)}%` : ""}
        </text>
        <text x={SPAD.left + chartW + 5} y={MAIN_H + SPAD.top + sChartH}
          fontSize="8" fill="#5a3340" fontFamily="monospace">
          {allSprd.length ? `${minSprd >= 0 ? "+" : ""}${fmtAxis(minSprd, rangeSprd)}%` : ""}
        </text>

        {/* Sub-chart label + border */}
        <rect x={SPAD.left} y={MAIN_H + SPAD.top} width={chartW} height={sChartH}
          fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
        <text x={SPAD.left + 5} y={MAIN_H + SPAD.top + 11}
          fontSize="8" fontFamily="monospace" fontWeight="bold"
          fill={subColor === "#22c55e" ? "#2d3f4f" : "#3a2f5a"}>
          {subLabel}
        </text>

        {/* X labels for sub-chart */}
        {(subIsProfit
          ? Array.from({ length: 4 }, (_, i) => subMinTs + (i / 3) * (subMaxTs - subMinTs))
          : xTicks.filter((_, i) => i % 2 === 0)
        ).map((ts, i) => (
          <text key={`sxt${ts}-${i}`} x={subXOf(ts)} y={MAIN_H + SPAD.top + sChartH + 14}
            fontSize="8" fill="#2d3748" fontFamily="monospace" textAnchor="middle">
            {fmtTime(ts)}
          </text>
        ))}

        {/* ── CROSSHAIR (rendered last = on top) ── */}
        {cursor && cursor.mx != null && (
          <g>
            {/* Vertical lines */}
            <line x1={cursor.mx} y1={PAD.top} x2={cursor.mx} y2={PAD.top + chartH}
              stroke="rgba(255,255,255,0.28)" strokeWidth="1" strokeDasharray="4,3" />
            <line x1={cursor.mx} y1={MAIN_H + SPAD.top} x2={cursor.mx} y2={MAIN_H + SPAD.top + sChartH}
              stroke="rgba(255,255,255,0.18)" strokeWidth="1" strokeDasharray="4,3" />

            {/* Per-series dots + horizontal lines + Y-axis pills */}
            {snapX != null && cursor.vals.map((sv) => {
              if (sv.price == null) return null;
              const y = yOf(sv.price);
              return (
                <g key={sv.exchange}>
                  <line x1={PAD.left} y1={y} x2={PAD.left + chartW} y2={y}
                    stroke={sv.color} strokeWidth="0.7" strokeDasharray="3,5" opacity="0.45" />
                  <circle cx={snapX} cy={y} r={5.5}
                    fill={sv.color} stroke="rgba(8,12,20,0.9)" strokeWidth="2.5"
                    style={{ filter: `drop-shadow(0 0 5px ${sv.color}aa)` }} />
                  <circle cx={snapX} cy={y} r={2.5} fill="white" opacity="0.95" />
                  <rect x={PAD.left + chartW + 1} y={y - 9} width={72} height={18}
                    fill={sv.color} rx="3" opacity="0.95" />
                  <text x={PAD.left + chartW + 37} y={y + 4.5}
                    fontSize="9" fill="#050c14" fontFamily="monospace" fontWeight="bold" textAnchor="middle">
                    {fmtAxis(sv.price, rangeP)}
                  </text>
                </g>
              );
            })}

            {/* Sub-chart dot + Y pill */}
            {(() => {
              const sv = cursor.subValue;
              if (sv == null) return null;
              const sprdY2 = syOf(sv);
              if (sprdY2 < MAIN_H + SPAD.top || sprdY2 > MAIN_H + SPAD.top + sChartH) return null;
              const dotX     = (subIsProfit && cursor.subTs != null) ? subXOf(cursor.subTs) : snapX;
              const dotColor = sv >= 0 ? "#22c55e" : "#f87171";
              return (
                <g>
                  <circle cx={dotX} cy={sprdY2} r={4}
                    fill={dotColor} stroke="rgba(8,12,20,0.9)" strokeWidth="2"
                    style={{ filter: `drop-shadow(0 0 4px ${dotColor}99)` }} />
                  <rect x={SPAD.left + chartW + 1} y={sprdY2 - 8} width={72} height={16}
                    fill={dotColor} rx="3" opacity="0.9" />
                  <text x={SPAD.left + chartW + 37} y={sprdY2 + 4}
                    fontSize="9" fill="#050c14" fontFamily="monospace" fontWeight="bold" textAnchor="middle">
                    {sv.toFixed(3)}%
                  </text>
                </g>
              );
            })()}

            {/* Time label on X axis */}
            <rect x={cursor.mx - 26} y={PAD.top + chartH + 2} width={52} height={15}
              fill="rgba(255,255,255,0.12)" rx="3" />
            <text x={cursor.mx} y={PAD.top + chartH + 13}
              fontSize="8.5" fill="rgba(255,255,255,0.75)" fontFamily="monospace" textAnchor="middle">
              {fmtTime(cursor.ts)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ── CrossoverChart — full-size absolute ask vs bid with crossing fills ──────
function CrossoverChart({ buyData, sellData, buyExchange, sellExchange, onCursor, onPanDelta, isPanned }) {
  const svgRef = useRef(null);
  const [sz, setSz] = useState({ w: 840, h: 420 });
  const [grabbing, setGrabbing] = useState(false);

  const isDragging  = useRef(false);
  const dragLastX   = useRef(0);
  const hasDragged  = useRef(false);
  const rafPending  = useRef(null);
  const pendingDeltaMs = useRef(0);

  useEffect(() => {
    if (!svgRef.current) return;
    const ro = new ResizeObserver(([e]) =>
      setSz({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    ro.observe(svgRef.current);
    return () => ro.disconnect();
  }, []);

  const CPAD = { top: 20, right: 76, bottom: 28, left: 10 };
  const { w, h } = sz;
  const chartW = Math.max(10, w - CPAD.left - CPAD.right);
  const chartH = Math.max(10, h - CPAD.top  - CPAD.bottom);

  const buyCol  = exColor(buyExchange);
  const sellCol = exColor(sellExchange);

  // One useMemo that builds aligned pairs + all scale info before the early return.
  // Avoids re-running O(n log n) alignment + O(n) scale computation on sz changes.
  const ccRender = useMemo(() => {
    if (!buyData?.length || !sellData?.length) return null;
    const pts = buyData
      .filter((b) => isFinite(b.price) && isFinite(b.ts))
      .map((b) => {
        const s = binaryNearest(sellData, b.ts);
        if (!s || !s.price) return null;
        return { ts: b.ts, ask: b.price, bid: s.price };
      })
      .filter(Boolean);
    if (pts.length < 2) return null;
    // Min/max via loop — safe for large arrays (Math.min/max spread can overflow stack)
    let tMn = pts[0].ts, tMx = pts[0].ts, pMn = pts[0].ask, pMx = pts[0].ask;
    for (const d of pts) {
      if (d.ts < tMn) tMn = d.ts; if (d.ts > tMx) tMx = d.ts;
      if (d.ask < pMn) pMn = d.ask; if (d.ask > pMx) pMx = d.ask;
      if (d.bid < pMn) pMn = d.bid; if (d.bid > pMx) pMx = d.bid;
    }
    return { aligned: pts, minTs: tMn, maxTs: tMx, minP: pMn, maxP: pMx };
  }, [buyData, sellData]);

  const aligned = ccRender?.aligned ?? [];
  const noData  = !ccRender;
  const minTs   = ccRender?.minTs ?? 0;
  const maxTs   = ccRender?.maxTs ?? 1;
  const msPerPx = ((maxTs - minTs) || 3_600_000) / (chartW || 1);

  function clientToSvg(clientX, clientY) {
    if (!svgRef.current) return { mx: 0, my: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    return {
      mx: (clientX - rect.left) / rect.width  * w,
      my: (clientY - rect.top)  / rect.height * h,
    };
  }

  function schedulePan(deltaMs) {
    pendingDeltaMs.current += deltaMs;
    if (rafPending.current) return;
    rafPending.current = requestAnimationFrame(() => {
      onPanDelta(pendingDeltaMs.current);
      pendingDeltaMs.current = 0;
      rafPending.current = null;
    });
  }

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const { mx } = clientToSvg(e.clientX, e.clientY);
    isDragging.current = true;
    hasDragged.current = false;
    dragLastX.current  = mx;
    setGrabbing(true);
    e.preventDefault();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h]);

  const handleMM = useCallback((e) => {
    const { mx } = clientToSvg(e.clientX, e.clientY);
    if (isDragging.current) {
      const dx = mx - dragLastX.current;
      if (Math.abs(dx) > 1) hasDragged.current = true;
      dragLastX.current = mx;
      if (Math.abs(dx) > 0.3) schedulePan(-dx * msPerPx);
      onCursor(null);
      return;
    }
    if (noData || mx < CPAD.left || mx > CPAD.left + chartW + 8) {
      onCursor(null); return;
    }
    const mxC      = Math.min(mx, CPAD.left + chartW);
    const tsCursor = minTs + ((mxC - CPAD.left) / chartW) * (maxTs - minTs);
    const askPt = binaryNearest(buyData  || [], tsCursor);
    const bidPt = binaryNearest(sellData || [], tsCursor);
    const spread = (askPt?.price && bidPt?.price)
      ? ((bidPt.price - askPt.price) / askPt.price) * 100
      : null;
    onCursor({
      mx: mxC, ts: tsCursor, spread,
      vals: [
        { exchange: buyExchange,  color: buyCol,  price: askPt?.price ?? null, label: "ASK" },
        { exchange: sellExchange, color: sellCol, price: bidPt?.price ?? null, label: "BID" },
      ],
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyData, sellData, noData, minTs, maxTs, chartW, msPerPx, w, h, buyExchange, sellExchange, buyCol, sellCol, onCursor]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false; setGrabbing(false);
  }, []);

  const handleML = useCallback(() => {
    isDragging.current = false; setGrabbing(false);
    onCursor(null);
  }, [onCursor]);

  // ── All pixel geometry memoized together ─────────────────────────────────
  // MUST be before the early return — Rules of Hooks.
  // Recomputes only when data or chart dimensions change — NOT on grabbing state.
  const ccGeom = useMemo(() => {
    if (!ccRender) return null;
    const { minP, maxP, aligned: pts } = ccRender;
    const rangeP = (maxP - minP) || Math.abs(maxP) * 0.005 || 1;
    const padP   = rangeP * 0.14;
    const p0 = minP - padP, p1 = maxP + padP;
    const xOf = (ts) => CPAD.left + ((ts - minTs) / ((maxTs - minTs) || 1)) * chartW;
    const yOf = (p)  => CPAD.top  + (1 - (p - p0) / ((p1 - p0) || 1)) * chartH;

    // Crossing fills
    const fills = [], crossings = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const cur = pts[i], next = pts[i + 1];
      const cs = cur.bid  - cur.ask;
      const ns = next.bid - next.ask;
      const x0 = xOf(cur.ts),  y0a = yOf(cur.ask),  y0b = yOf(cur.bid);
      const x1 = xOf(next.ts), y1a = yOf(next.ask), y1b = yOf(next.bid);
      if ((cs >= 0) === (ns >= 0)) {
        fills.push({
          d: `M${x0.toFixed(1)},${y0a.toFixed(1)} L${x1.toFixed(1)},${y1a.toFixed(1)} L${x1.toFixed(1)},${y1b.toFixed(1)} L${x0.toFixed(1)},${y0b.toFixed(1)} Z`,
          positive: cs >= 0,
        });
      } else {
        const t  = -cs / ((ns - cs) || 1);
        const cx = x0 + t * (x1 - x0);
        const cy = (y0a + t * (y1a - y0a) + y0b + t * (y1b - y0b)) / 2;
        crossings.push(cx);
        fills.push({ d: `M${x0.toFixed(1)},${y0a.toFixed(1)} L${cx.toFixed(1)},${cy.toFixed(1)} L${x0.toFixed(1)},${y0b.toFixed(1)} Z`, positive: cs >= 0 });
        fills.push({ d: `M${cx.toFixed(1)},${cy.toFixed(1)} L${x1.toFixed(1)},${y1a.toFixed(1)} L${x1.toFixed(1)},${y1b.toFixed(1)} Z`, positive: ns >= 0 });
      }
    }

    const askPts = pts.map((d) => [xOf(d.ts), yOf(d.ask)]);
    const bidPts = pts.map((d) => [xOf(d.ts), yOf(d.bid)]);
    const gapPx  = chartW / Math.max(1, (maxTs - minTs) / 30_000) * 3;
    const yLabels = Array.from({ length: 6 }, (_, i) => {
      const p = p0 + (i / 5) * (p1 - p0);
      return { p, y: yOf(p) };
    });
    const xLabels = Array.from({ length: 7 }, (_, i) => {
      const ts = minTs + (i / 6) * (maxTs - minTs);
      return { ts, x: xOf(ts) };
    });
    const last      = pts[pts.length - 1];
    const spreadNow = last ? ((last.bid - last.ask) / last.ask) * 100 : null;
    return { p0, p1, rangeP, xOf, yOf, fills, crossings, askPts, bidPts, gapPx, yLabels, xLabels, spreadNow };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ccRender, minTs, maxTs, chartW, chartH]);

  // ── Early return AFTER all hooks (Rules of Hooks) ─────────────────────────
  if (noData || !ccGeom) {
    return (
      <div ref={svgRef} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "#334155", fontSize: 12 }}>No price data for selected range</span>
      </div>
    );
  }

  const { p0, p1, rangeP, xOf, yOf, fills, crossings, askPts, bidPts, gapPx, yLabels, xLabels, spreadNow } = ccGeom;
  const spreadPos = spreadNow != null && spreadNow >= 0;

  return (
    <svg
      ref={svgRef}
      style={{
        flex: 1, display: "block", width: "100%", height: "100%",
        cursor: grabbing ? "grabbing" : "crosshair",
        userSelect: "none",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMM}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleML}
    >
      {/* Background */}
      <rect x={CPAD.left} y={CPAD.top} width={chartW} height={chartH}
        fill="rgba(255,255,255,0.012)" rx={4} />

      {/* Y-axis grid + labels */}
      {yLabels.map(({ p, y }, i) => (
        <g key={i}>
          <line x1={CPAD.left} y1={y} x2={CPAD.left + chartW} y2={y}
            stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
          <text x={CPAD.left + chartW + 6} y={y + 4}
            fontSize={9} fill="#334155" fontFamily="monospace" textAnchor="start">
            {fmtAxis(p, rangeP)}
          </text>
        </g>
      ))}

      {/* X-axis time labels */}
      {xLabels.map(({ ts, x }, i) => (
        <text key={i} x={x} y={CPAD.top + chartH + 16}
          fontSize={8} fill="#2d3f55" fontFamily="monospace" textAnchor="middle">
          {fmtTime(ts)}
        </text>
      ))}

      {/* Spread fill segments */}
      {fills.map((f, i) => (
        <path key={i} d={f.d}
          fill={f.positive ? "rgba(34,197,94,0.18)" : "rgba(248,113,113,0.18)"}
          stroke="none" />
      ))}

      {/* Crossing markers */}
      {crossings.map((cx, i) => (
        <line key={i}
          x1={cx.toFixed(1)} y1={CPAD.top}
          x2={cx.toFixed(1)} y2={CPAD.top + chartH}
          stroke="rgba(255,255,255,0.30)" strokeWidth={1} strokeDasharray="3,4" />
      ))}

      {/* BID line — dashed (sell exchange color) */}
      {bidPts.length >= 2 && (
        <path d={mkSmoothLine(bidPts, gapPx)} fill="none" stroke={sellCol}
          strokeWidth={2} strokeDasharray="7,4"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ filter: `drop-shadow(0 0 5px ${sellCol}55)` }} />
      )}

      {/* ASK line — solid (buy exchange color) */}
      {askPts.length >= 2 && (
        <path d={mkSmoothLine(askPts, gapPx)} fill="none" stroke={buyCol}
          strokeWidth={2.5}
          strokeLinecap="round" strokeLinejoin="round"
          style={{ filter: `drop-shadow(0 0 5px ${buyCol}55)` }} />
      )}

      {/* Crossover count chip */}
      {crossings.length > 0 && (
        <g>
          <rect x={CPAD.left + 6} y={CPAD.top - 14} width={56} height={13}
            fill="rgba(148,163,184,0.12)" rx={3} />
          <text x={CPAD.left + 34} y={CPAD.top - 4}
            fontSize={8} fill="rgba(148,163,184,0.75)"
            fontFamily="monospace" fontWeight="bold" textAnchor="middle">
            {crossings.length}✕ cross
          </text>
        </g>
      )}

      {/* Current spread badge (top-right, before Y-axis labels) */}
      {spreadNow != null && (
        <g>
          <rect x={CPAD.left + chartW - 58} y={CPAD.top - 14} width={58} height={13}
            fill={spreadPos ? "rgba(34,197,94,0.15)" : "rgba(248,113,113,0.15)"} rx={3} />
          <text x={CPAD.left + chartW - 3} y={CPAD.top - 4}
            fontSize={8.5} fill={spreadPos ? "#22c55e" : "#f87171"}
            fontFamily="monospace" fontWeight="bold" textAnchor="end">
            {spreadNow >= 0 ? "+" : ""}{spreadNow.toFixed(3)}%
          </text>
        </g>
      )}

      {/* Border */}
      <rect x={CPAD.left} y={CPAD.top} width={chartW} height={chartH}
        fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={1} rx={4} />
    </svg>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────
export function PriceChartModal({ open, onClose, symbol, buyExchange, sellExchange, buySparkline, sellSparkline, loading = false, fees, initialRange, mode = "spread" }) {
  const [range, setRange]       = useState(() => initialRange ?? loadSpotDefaults().chartDefaultRange);
  const [subChart, setSubChart] = useState("spread");
  const [cursor, setCursor]     = useState(null);
  // panDeltaMs: how many ms behind "now" the right edge of the window is.
  // 0 = live (showing latest). Positive = looking at older data.
  const [panDeltaMs, setPanDeltaMs] = useState(0);

  const RANGES  = ["1H", "2H", "4H", "8H", "12H", "24H"];
  const hoursMap = { "1H": 1, "2H": 2, "4H": 4, "8H": 8, "12H": 12, "24H": 24 };
  const hours   = hoursMap[range] ?? 4;

  // When modal opens with a new initialRange, apply it
  useEffect(() => {
    if (open && initialRange && RANGES.includes(initialRange)) setRange(initialRange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialRange]);

  // Reset pan when range or symbol changes
  useEffect(() => { setPanDeltaMs(0); }, [range, symbol]);

  // Oldest timestamp across ALL raw sparkline data — used for pan clamping.
  // Memoized against source data + hours so it doesn't rerun on cursor moves.
  const minAvailTs = useMemo(() => {
    const all = [...(buySparkline || []), ...(sellSparkline || [])];
    if (!all.length) return Date.now() - hours * 3_600_000;
    let min = Infinity;
    for (const d of all) { if (isFinite(d.ts) && d.ts < min) min = d.ts; }
    return min === Infinity ? Date.now() - hours * 3_600_000 : min;
  }, [buySparkline, sellSparkline, hours]);

  // Maximum we can pan back: oldest available data minus one window width
  const maxPanMs = useMemo(
    () => Math.max(0, Date.now() - minAvailTs - hours * 3_600_000),
    [minAvailTs, hours],
  );

  const handlePanDelta = useCallback((deltaMs) => {
    setPanDeltaMs((prev) => Math.max(0, Math.min(maxPanMs, prev + deltaMs)));
  }, [maxPanMs]);

  // anchorTs = right edge of the visible time window.
  // Memoized on panDeltaMs so chart data doesn't recompute on unrelated state.
  const anchorTs = useMemo(() => Date.now() - panDeltaMs, [panDeltaMs]);
  const isPanned = panDeltaMs > 10_000; // true when not at live edge

  // Range-filtered data arrays — recompute only when sparkline data or window changes.
  const buyData  = useMemo(() => filterByRange(buySparkline,  hours, anchorTs), [buySparkline,  hours, anchorTs]);
  const sellData = useMemo(() => filterByRange(sellSparkline, hours, anchorTs), [sellSparkline, hours, anchorTs]);

  // Series descriptors — recompute only when exchange identity or data changes.
  const series = useMemo(() => [
    { exchange: buyExchange,  color: exColor(buyExchange),  data: buyData  || [] },
    { exchange: sellExchange, color: exColor(sellExchange), data: sellData || [] },
  ], [buyExchange, sellExchange, buyData, sellData]);

  // Spread series & pct-change chips — O(n log n), recompute only on data change.
  const spreadSeries = useMemo(() => buildSpread(buyData, sellData), [buyData, sellData]);
  const buyPct       = useMemo(() => pctChange(buyData),  [buyData]);
  const sellPct      = useMemo(() => pctChange(sellData), [sellData]);

  // Net profit sub-data — recompute only when spread series or fees change.
  const profitSubData = useMemo(() => {
    if (!spreadSeries.length) return [];
    const f = fees ?? {};
    const buyFeeEff  = (f.buyFeeRate  ?? 0.001) * (1 + (f.feeTaxRate ?? 0)) * 100;
    const sellFeeEff = (f.sellFeeRate ?? 0.001) * (1 + (f.feeTaxRate ?? 0)) * 100;
    const tds        = (f.tdsRate ?? 0.01) * 100;
    const totalFees  = buyFeeEff + sellFeeEff + tds;
    return spreadSeries.map((d) => ({ ts: d.ts, value: d.spread - totalFees }));
  }, [spreadSeries, fees]);

  // Sub-chart data — recompute only when sub-chart mode or underlying data changes.
  const subData = useMemo(() =>
    subChart === "profit"
      ? profitSubData
      : spreadSeries.map((d) => ({ ts: d.ts, value: d.spread })),
    [subChart, profitSubData, spreadSeries],
  );
  const subLabel    = subChart === "profit" ? "NET PROFIT %" : "SPREAD %";
  const subColor    = subChart === "profit" ? "#a78bfa" : "#22c55e";
  const subIsProfit = subChart === "profit";

  const curSubValue = useMemo(
    () => subData.length ? subData[subData.length - 1].value : null,
    [subData],
  );

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.74)",
        backdropFilter: "blur(8px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width:  "min(880px, 100%)",
          height: "min(560px, 88vh)",
          background: "linear-gradient(160deg,#0d1117 0%,#080c14 100%)",
          border: "1px solid rgba(255,255,255,0.09)",
          borderRadius: 14,
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 28px 72px rgba(0,0,0,0.80), 0 0 0 1px rgba(255,255,255,0.04)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── HEADER ── */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          background: "rgba(255,255,255,0.025)",
          flexShrink: 0, flexWrap: "wrap",
        }}>
          <CoinIcon symbol={symbol} size={22} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#e2e8f0" }}>{symbol}/USDT</div>
            <div style={{ fontSize: 8, color: "#334155", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {mode === "crossover" ? "Price Crossover · BUY ask vs SELL bid" : "Price · Spread Chart"}
            </div>
          </div>

          {/* Exchange chips */}
          {series.map((s, i) => {
            const pct   = i === 0 ? buyPct : sellPct;
            const isPos = pct != null && pct >= 0;
            return (
              <div key={s.exchange} style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 9px", borderRadius: 7,
                background: `${s.color}15`,
                border: `1px solid ${s.color}50`,
                boxShadow: `0 0 12px ${s.color}20`,
              }}>
                <ExchangeIcon name={s.exchange} size={13} />
                <span style={{ fontSize: 11, fontWeight: 700, color: s.color }}>{exLabel(s.exchange)}</span>
                <svg width={18} height={3}>
                  {i === 0
                    ? <line x1={0} y1={1.5} x2={18} y2={1.5} stroke={s.color} strokeWidth={2} />
                    : <line x1={0} y1={1.5} x2={18} y2={1.5} stroke={s.color} strokeWidth={1.8} strokeDasharray="5,2.5" />
                  }
                </svg>
                {pct != null && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, fontFamily: "monospace",
                    color: isPos ? "#4ade80" : "#f87171",
                    background: isPos ? "rgba(74,222,128,0.10)" : "rgba(248,113,113,0.10)",
                    padding: "1px 5px", borderRadius: 4,
                  }}>
                    {pct.toFixed(2)}%
                  </span>
                )}
              </div>
            );
          })}

          {/* Current sub-chart value chip */}
          {curSubValue != null && (
            <div style={{
              padding: "4px 9px", borderRadius: 7,
              background: curSubValue >= 0 ? "rgba(34,197,94,0.10)" : "rgba(248,113,113,0.10)",
              border: `1px solid ${curSubValue >= 0 ? "rgba(34,197,94,0.35)" : "rgba(248,113,113,0.35)"}`,
            }}>
              <span style={{ fontSize: 8.5, color: "#475569", fontWeight: 600 }}>{subLabel.split(" ")[0]} </span>
              <span style={{
                fontSize: 11, fontWeight: 800, fontFamily: "monospace",
                color: curSubValue >= 0 ? "#4ade80" : "#f87171",
              }}>
                {curSubValue.toFixed(3)}%
              </span>
            </div>
          )}

          <div style={{ flex: 1 }} />

          {/* Sub-chart toggle — only for spread mode */}
          {mode !== "crossover" && (
            <div style={{ display: "flex", gap: 2, borderRadius: 7, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)" }}>
              {[
                { key: "spread", label: "SPREAD" },
                { key: "profit", label: "NET PROFIT" },
              ].map(({ key, label }) => {
                const active = subChart === key;
                const ac = key === "profit" ? "#a78bfa" : "#22c55e";
                return (
                  <button key={key} onClick={() => setSubChart(key)} style={{
                    padding: "3px 9px", fontSize: 9, fontWeight: 700, fontFamily: "monospace",
                    cursor: "pointer", border: "none", transition: "all 0.12s",
                    background: active ? `${ac}22` : "rgba(255,255,255,0.03)",
                    color:      active ? ac : "#374151",
                    boxShadow:  active ? `inset 0 0 8px ${ac}18` : "none",
                  }}>
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Time range */}
          <div style={{ display: "flex", gap: 3 }}>
            {RANGES.map((r) => (
              <button key={r} onClick={() => setRange(r)} style={{
                padding: "3px 10px", borderRadius: 6,
                fontSize: 10, fontWeight: 700, fontFamily: "monospace",
                cursor: "pointer",
                background: range === r ? "rgba(99,102,241,0.22)" : "rgba(255,255,255,0.04)",
                border:     range === r ? "1px solid rgba(99,102,241,0.55)" : "1px solid rgba(255,255,255,0.07)",
                color:      range === r ? "#a5b4fc" : "#475569",
                boxShadow:  range === r ? "0 0 8px rgba(99,102,241,0.28)" : "none",
                transition: "all 0.12s",
              }}>
                {r}
              </button>
            ))}
          </div>

          {/* Close */}
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: 7,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "#475569", display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", transition: "all 0.12s",
          }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.10)"; e.currentTarget.style.color = "#e2e8f0"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.color = "#475569"; }}
          >
            <X size={13} />
          </button>
        </div>

        {/* ── TOOLTIP BAR ── */}
        <div style={{
          height: 30, flexShrink: 0,
          display: "flex", alignItems: "center", gap: 16,
          padding: "0 14px",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          background: "rgba(0,0,0,0.28)",
          fontSize: 11, fontFamily: "monospace",
          opacity: cursor ? 1 : 0.3, transition: "opacity 0.1s",
        }}>
          {cursor ? (
            <>
              <span style={{ color: "#334155", fontSize: 10 }}>⏱ {fmtTooltipTs(cursor.ts)}</span>
              {cursor.vals.map((sv) => sv.price != null && (
                <span key={sv.exchange} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%", background: sv.color,
                    display: "inline-block", boxShadow: `0 0 5px ${sv.color}`,
                  }} />
                  <span style={{ color: "#334155" }}>{exLabel(sv.exchange)}{sv.label ? ` ${sv.label}` : ""}</span>
                  <span style={{ color: sv.color, fontWeight: 700 }}>{fmtPrice(sv.price)}</span>
                </span>
              ))}
              {mode === "crossover" && cursor.spread != null && (
                <span style={{ color: cursor.spread >= 0 ? "#4ade80" : "#f87171", fontWeight: 700 }}>
                  │ SPREAD {cursor.spread >= 0 ? "+" : ""}{cursor.spread.toFixed(3)}%
                </span>
              )}
              {mode !== "crossover" && cursor.subValue != null && (
                <span style={{ color: cursor.subValue >= 0 ? "#4ade80" : "#f87171", fontWeight: 700 }}>
                  │ {subLabel} {cursor.subValue.toFixed(3)}%
                </span>
              )}
            </>
          ) : (
            <span style={{ color: "#1e293b", fontSize: 10 }}>
              {mode === "crossover"
                ? `Hover · crosshair shows ASK & BID prices + spread%${maxPanMs > 0 ? " · drag to pan" : ""}`
                : `Hover · crosshair shows exact price + ${subChart === "profit" ? "net profit" : "spread"}${maxPanMs > 0 ? " · drag left/right to pan through history" : ""}`
              }
            </span>
          )}
        </div>

        {/* ── CHART ── */}
        <div style={{ flex: 1, padding: "8px 4px 4px 4px", minHeight: 0, display: "flex" }}>
          {loading ? (
            <div style={{
              flex: 1, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 14,
            }}>
              <svg width={32} height={32} viewBox="0 0 32 32" style={{ animation: "spin 0.9s linear infinite" }}>
                <circle cx={16} cy={16} r={13} fill="none" stroke="rgba(99,102,241,0.18)" strokeWidth={3} />
                <path d="M16 3 A13 13 0 0 1 29 16" fill="none" stroke="#6366f1" strokeWidth={3} strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 11, color: "#334155", fontFamily: "monospace", fontWeight: 600, letterSpacing: "0.04em" }}>
                Loading price data…
              </span>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : mode === "crossover" ? (
            <CrossoverChart
              buyData={buyData}
              sellData={sellData}
              buyExchange={buyExchange}
              sellExchange={sellExchange}
              onCursor={setCursor}
              onPanDelta={handlePanDelta}
              isPanned={isPanned}
            />
          ) : (
            <PriceChart
              series={series}
              subData={subData}
              subLabel={subLabel}
              subColor={subColor}
              subIsProfit={subIsProfit}
              onCursor={setCursor}
              onPanDelta={handlePanDelta}
              isPanned={isPanned}
            />
          )}
        </div>

        {/* ── FOOTER ── */}
        <div style={{
          padding: "5px 14px",
          borderTop: "1px solid rgba(255,255,255,0.04)",
          background: "rgba(0,0,0,0.30)",
          display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
        }}>
          <span style={{ fontSize: 8, color: "#1a2433", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Live WS feed · ~30s intervals · Esc to close
          </span>

          {/* Pan controls */}
          {maxPanMs > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {isPanned && (
                <button
                  onClick={() => setPanDeltaMs(0)}
                  style={{
                    fontSize: 8, fontWeight: 700, fontFamily: "monospace",
                    padding: "2px 7px", borderRadius: 4, cursor: "pointer",
                    background: "rgba(34,197,94,0.15)",
                    border: "1px solid rgba(34,197,94,0.35)",
                    color: "#4ade80",
                  }}
                >
                  ● LIVE
                </button>
              )}
              <span style={{ fontSize: 8, color: "#1e3040", fontFamily: "monospace" }}>
                {isPanned ? `◀ ${Math.round(panDeltaMs / 60_000)}m ago` : "◀ drag to pan history"}
              </span>
            </div>
          )}

          <div style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
            {series.map((s) => {
              const last = (s.data || [])[(s.data || []).length - 1]?.price;
              return last != null && (
                <span key={s.exchange} style={{ fontSize: 10, fontFamily: "monospace" }}>
                  <span style={{ color: "#2d3f55" }}>{exLabel(s.exchange)}: </span>
                  <span style={{ color: s.color, fontWeight: 700 }}>{fmtPrice(last)}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
