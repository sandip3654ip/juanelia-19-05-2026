/**
 * CoinIcon — shows a token image next to a symbol.
 * Falls back through two free CDNs before rendering nothing.
 *
 * CDN chain:
 *  1. jsDelivr / cryptocurrency-icons  — covers ~400 major coins
 *  2. CoinCap assets                   — broader altcoin coverage
 *  → null if both fail (no broken-image placeholder shown)
 */

import { useState } from "react";

const JSDELIVR = (s) =>
  `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${s}.png`;
const COINCAP = (s) =>
  `https://assets.coincap.io/assets/icons/${s}@2x.png`;

export function CoinIcon({ symbol, size = 22 }) {
  if (!symbol) return null;
  const slug = symbol.toLowerCase();
  const [src, setSrc]       = useState(() => JSDELIVR(slug));
  const [failed, setFailed] = useState(false);

  const handleError = () => {
    if (src === JSDELIVR(slug)) {
      setSrc(COINCAP(slug));
    } else {
      setFailed(true);
    }
  };

  if (failed) return null;
  return (
    <img
      src={src}
      onError={handleError}
      alt={symbol}
      width={size}
      height={size}
      className="rounded-full flex-shrink-0"
      style={{ imageRendering: "auto" }}
    />
  );
}
