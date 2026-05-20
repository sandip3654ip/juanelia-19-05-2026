/**
 * ExchangeIcon — exchange logo from CoinMarketCap CDN (for major exchanges)
 * or locally hosted icon (for DEX / Indian exchanges).
 * Falls back to a brand-colored circle with the first letter.
 */

import { useState } from "react";

// CoinMarketCap exchange IDs (major CEXs)
const CMC_ID = {
  binance: 270,
  bybit:   521,
  kucoin:  311,
  bitget:  513,
  kraken:  24,
};

// Local icons in /public/exchange-icons/ (served under BASE_URL)
const LOCAL_ICON = {
  pi42:       "pi42.png",
  aster:      "aster.png",
  delta:      "delta.png",
  coinswitch: "coinswitch.png",
};

const BRAND = {
  binance:    "#f0b90b",
  bybit:      "#f7a600",
  kucoin:     "#0dbb6f",
  bitget:     "#00c6ff",
  kraken:     "#7f5af0",
  pi42:       "#6366f1",
  aster:      "#a855f7",
  delta:      "#3b82f6",
  coinswitch: "#10b981",
  telegram:   "#29b6f6",
};

const cmcUrl   = (id)  => `https://s2.coinmarketcap.com/static/img/exchanges/64x64/${id}.png`;
const localUrl = (file) => `${import.meta.env.BASE_URL}exchange-icons/${file}`;

export function ExchangeIcon({ name, size = 18 }) {
  const key   = (name || "").toLowerCase();
  const cmcId = CMC_ID[key];
  const local = LOCAL_ICON[key];
  const brand = BRAND[key] ?? "var(--app-text-muted)";

  const [failed, setFailed] = useState(false);

  const src = !failed
    ? cmcId   ? cmcUrl(cmcId)
    : local   ? localUrl(local)
    : null
    : null;

  if (src) {
    return (
      <img
        src={src}
        onError={() => setFailed(true)}
        alt={name}
        width={size}
        height={size}
        className="rounded-full flex-shrink-0 object-cover"
        style={{ imageRendering: "auto" }}
      />
    );
  }

  // Fallback — brand-colored circle with first letter
  return (
    <span
      aria-label={name}
      className="inline-flex items-center justify-center rounded-full flex-shrink-0 font-extrabold"
      style={{
        width:      size,
        height:     size,
        background: brand,
        color:      "#0a0a12",
        fontSize:   Math.round(size * 0.55),
        lineHeight: 1,
      }}
    >
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}
